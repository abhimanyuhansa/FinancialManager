import {
  LLMProvider,
  ParsedEmailItem,
  StatementItem,
  ProviderCallResult,
  StatementCallResult,
  ProviderBadRequestError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderParseError,
} from "./types";
import {
  BATCH_SYSTEM_PROMPT,
  buildBatchUserPrompt,
  STATEMENT_SYSTEM_PROMPT,
  buildStatementUserPrompt,
  OPENAI_EMAIL_JSON_SCHEMA,
  EmailInput,
} from "../prompts";

const PROVIDER: LLMProvider = "openai";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS ?? 30_000);
const OPENAI_API_BASE = "https://api.openai.com/v1";

function throwForStatus(status: number, detail: string): never {
  if (status === 400) throw new ProviderBadRequestError(PROVIDER, `400: ${detail.slice(0, 100)}`);
  if (status === 401 || status === 403) throw new ProviderAuthError(PROVIDER, `${status}: ${detail.slice(0, 100)}`);
  if (status === 429) throw new ProviderRateLimitError(PROVIDER, `429: ${detail.slice(0, 100)}`);
  throw new ProviderServerError(PROVIDER, `${status}: ${detail.slice(0, 100)}`);
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  jsonSchema?: Record<string, unknown>,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const openaiModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let res: Response;
  try {
    const body: Record<string, unknown> = {
      model: openaiModel,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    if (jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "email_parse",
          strict: true,
          schema: jsonSchema,
        },
      };
    }

    res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProviderTimeoutError(PROVIDER, `Timed out after ${OPENAI_TIMEOUT_MS}ms`);
    }
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errData = await res
      .json()
      .catch(() => ({ error: { message: "unknown" } })) as { error?: { message?: string } };
    throwForStatus(res.status, errData.error?.message ?? "");
  }

  const data = (await res.json()) as {
    choices?: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content ?? "";
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  return { text, inputTokens, outputTokens };
}

function parseJsonText<T>(text: string): T {
  const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(clean) as T;
  } catch {
    throw new ProviderParseError(PROVIDER, "Failed to parse JSON response", text.slice(0, 300));
  }
}

export async function callOpenAIEmailBatch(
  inputs: EmailInput[],
  apiKey: string
): Promise<ProviderCallResult> {
  const { text, inputTokens, outputTokens } = await callOpenAI(
    BATCH_SYSTEM_PROMPT,
    buildBatchUserPrompt(inputs),
    apiKey,
    OPENAI_EMAIL_JSON_SCHEMA as unknown as Record<string, unknown>,
  );

  const parsed = parseJsonText<{ results: ParsedEmailItem[] }>(text);
  const raw = parsed?.results;
  if (!Array.isArray(raw)) {
    throw new ProviderParseError(PROVIDER, "Response missing results array", text.slice(0, 300));
  }

  return { items: raw, inputTokens, outputTokens };
}

export async function callOpenAIStatement(
  body: string,
  apiKey: string
): Promise<StatementCallResult> {
  const { text, inputTokens, outputTokens } = await callOpenAI(
    STATEMENT_SYSTEM_PROMPT,
    buildStatementUserPrompt(body),
    apiKey
  );

  const raw = parseJsonText<StatementItem[]>(text);
  if (!Array.isArray(raw)) {
    throw new ProviderParseError(PROVIDER, "Response is not an array", text.slice(0, 300));
  }

  return { items: raw, inputTokens, outputTokens };
}
