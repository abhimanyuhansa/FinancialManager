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
  EMAIL_JSON_SCHEMA,
  EmailInput,
} from "../prompts";

const PROVIDER: LLMProvider = "gemini";
// Gemini free tier sometimes hangs instead of returning 429. Fail fast at 20s so
// the fallback (gpt-4o-mini, ~5-35s) can still complete within Vercel's 60s budget.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS ?? 20_000);

function throwForStatus(status: number, body: string): never {
  if (status === 400) throw new ProviderBadRequestError(PROVIDER, `400: ${body.slice(0, 100)}`);
  if (status === 401 || status === 403) throw new ProviderAuthError(PROVIDER, `${status}: ${body.slice(0, 100)}`);
  if (status === 429) throw new ProviderRateLimitError(PROVIDER, `429: ${body.slice(0, 100)}`);
  throw new ProviderServerError(PROVIDER, `${status}: ${body.slice(0, 100)}`);
}

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  responseSchema?: unknown
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let res: Response;
  try {
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      responseMimeType: "application/json",
    };
    if (responseSchema) generationConfig.responseSchema = responseSchema;

    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig,
        }),
        signal: controller.signal,
      }
    );
  } catch (e: unknown) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === "AbortError") {
      throw new ProviderTimeoutError(PROVIDER, `Timed out after ${GEMINI_TIMEOUT_MS}ms`);
    }
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throwForStatus(res.status, errBody);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
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

export async function callGeminiEmailBatch(
  inputs: EmailInput[],
  apiKey: string
): Promise<ProviderCallResult> {
  const { text, inputTokens, outputTokens } = await callGemini(
    BATCH_SYSTEM_PROMPT,
    buildBatchUserPrompt(inputs),
    apiKey,
    EMAIL_JSON_SCHEMA
  );

  const raw = parseJsonText<ParsedEmailItem[]>(text);
  if (!Array.isArray(raw)) {
    throw new ProviderParseError(PROVIDER, "Response is not an array", text.slice(0, 300));
  }

  return { items: raw, inputTokens, outputTokens };
}

export async function callGeminiStatement(
  body: string,
  apiKey: string
): Promise<StatementCallResult> {
  const { text, inputTokens, outputTokens } = await callGemini(
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
