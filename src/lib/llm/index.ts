import { prisma } from "@/lib/prisma";
import {
  LLMProvider,
  ParsedEmailItem,
  StatementItem,
  LlmCallContext,
  ProviderBadRequestError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderParseError,
  ProviderExhaustedError,
} from "./providers/types";
import { selectProvider, releaseQuota, SelectedProvider } from "./router";
import { callGeminiEmailBatch, callGeminiStatement } from "./providers/gemini";
import { callOpenAIEmailBatch, callOpenAIStatement } from "./providers/openai";
import { validateProviderResults } from "./validate";
import { recordSuccess, recordFailure, releaseHalfOpenProbe } from "./circuitBreaker";
import { estimateInputTokens, estimateOutputTokens, EmailInput } from "./prompts";
import { acquireIdempotencyKey, completeIdempotencyKey } from "./idempotency";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

function isRetryableError(err: unknown): boolean {
  // Timeout is NOT retryable: we're already at the end of the function budget.
  // Attempting a fallback call after a 30s+ timeout would immediately hit the
  // Vercel 60s limit, trip both circuit breakers, and cause "both exhausted".
  return (
    err instanceof ProviderRateLimitError ||
    err instanceof ProviderServerError ||
    err instanceof ProviderParseError
  );
}

async function logAttempt(
  ctx: LlmCallContext,
  batchKey: string | null,
  selected: SelectedProvider,
  attemptNumber: number,
  wasFallback: boolean,
  fallbackReason: string | null,
  outcome: string,
  latencyMs: number,
  inputTokens: number,
  outputTokens: number,
  errorDetail: string | null
): Promise<void> {
  try {
    await prisma.llmCallLog.create({
      data: {
        syncJobId: ctx.syncJobId ?? null,
        userId: ctx.userId,
        batchKey,
        provider: selected.provider,
        model:
          selected.provider === "gemini"
            ? (process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite")
            : (process.env.OPENAI_MODEL ?? "gpt-5-nano-2025-08-07"),
        candidateCount: 0,
        attemptNumber,
        wasFallback,
        fallbackReason,
        outcome,
        errorDetail,
        latencyMs,
        inputTokens,
        outputTokens,
        estimatedCostUsd: 0,
      },
    });
  } catch {
    // Logging failure is non-fatal
  }
}

async function callProvider(
  provider: LLMProvider,
  inputs: EmailInput[]
) {
  if (provider === "gemini") {
    return callGeminiEmailBatch(inputs, GEMINI_API_KEY);
  }
  return callOpenAIEmailBatch(inputs, OPENAI_API_KEY);
}

export async function parseEmailBatchLLM(
  inputs: EmailInput[],
  batchKey: string,
  ctx: LlmCallContext
): Promise<ParsedEmailItem[]> {
  // Idempotency gate — atomic claim or return cached result
  const idempResult = await acquireIdempotencyKey(batchKey);
  if (idempResult.status === "complete") {
    return idempResult.result;
  }

  const estimatedInput = estimateInputTokens(inputs);
  const estimatedOutput = estimateOutputTokens(inputs.length);

  const selected = await selectProvider(inputs.length, estimatedInput, estimatedOutput);

  const primaryProvider = selected.provider;
  const fallbackProvider: LLMProvider = primaryProvider === "gemini" ? "openai" : "gemini";
  let attemptNumber = 1;
  let fallbackReason: string | null = null;
  let currentSelected = selected;

  const attempt = async (): Promise<ParsedEmailItem[]> => {
    const start = Date.now();
    try {
      const callResult = await callProvider(currentSelected.provider, inputs);
      const validated = validateProviderResults(
        callResult.items,
        inputs.length,
        currentSelected.provider
      );
      const latencyMs = Date.now() - start;

      await logAttempt(
        ctx, batchKey, currentSelected, attemptNumber, attemptNumber > 1,
        fallbackReason, "success", latencyMs,
        callResult.inputTokens, callResult.outputTokens, null
      );
      await recordSuccess(currentSelected.provider);
      await completeIdempotencyKey(batchKey, validated);
      return validated;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errDetail = err instanceof Error ? err.message : String(err);

      await logAttempt(
        ctx, batchKey, currentSelected, attemptNumber, attemptNumber > 1,
        fallbackReason, "error", latencyMs, 0, 0, errDetail
      );

      if (!isRetryableError(err)) {
        // Non-retryable (400, 401, 403, timeout): record failure and clean up probe, then throw.
        // Timeout specifically must NOT attempt fallback — the Vercel 60s budget is already consumed.
        await recordFailure(currentSelected.provider);
        if (currentSelected.isHalfOpenProbe) {
          await releaseHalfOpenProbe(currentSelected.provider);
        }
        throw err;
      }

      await recordFailure(currentSelected.provider);
      if (currentSelected.isHalfOpenProbe) {
        await releaseHalfOpenProbe(currentSelected.provider);
      }

      if (attemptNumber === 1) {
        // Try fallback
        attemptNumber = 2;
        fallbackReason = errDetail;

        const fallbackEstInput = estimateInputTokens(inputs);
        const fallbackEstOutput = estimateOutputTokens(inputs.length);
        const fallbackSelected = await selectProvider(
          inputs.length, fallbackEstInput, fallbackEstOutput
        ).catch(() => null);

        if (!fallbackSelected || fallbackSelected.provider !== fallbackProvider) {
          throw new ProviderExhaustedError(primaryProvider, fallbackProvider);
        }

        if (currentSelected.isHalfOpenProbe) {
          await releaseQuota(
            currentSelected.provider, 1,
            currentSelected.reservedInputTokens,
            currentSelected.reservedOutputTokens
          );
        }

        currentSelected = fallbackSelected;
        return attempt();
      }

      throw new ProviderExhaustedError(primaryProvider, fallbackProvider);
    }
  };

  return attempt();
}

export async function parseStatementLLM(
  body: string,
  ctx: LlmCallContext
): Promise<StatementItem[]> {
  const estimatedInput = Math.ceil(body.length / 4);
  const estimatedOutput = 200;

  const selected = await selectProvider(1, estimatedInput, estimatedOutput);
  const start = Date.now();

  try {
    let result;
    if (selected.provider === "gemini") {
      result = await callGeminiStatement(body, GEMINI_API_KEY);
    } else {
      result = await callOpenAIStatement(body, OPENAI_API_KEY);
    }
    const latencyMs = Date.now() - start;

    await logAttempt(
      ctx, null, selected, 1, false, null, "success", latencyMs,
      result.inputTokens, result.outputTokens, null
    );
    await recordSuccess(selected.provider);
    return result.items;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errDetail = err instanceof Error ? err.message : String(err);
    await logAttempt(
      ctx, null, selected, 1, false, null, "error", latencyMs, 0, 0, errDetail
    );
    await recordFailure(selected.provider);
    throw err;
  }
}
