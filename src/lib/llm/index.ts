import { prisma } from "@/lib/prisma";
import {
  ParsedEmailItem,
  StatementItem,
  LlmCallContext,
  isAvailabilityError,
  ProviderContractError,
} from "./providers/types";
import { selectProvider, releaseQuota, SelectedProvider } from "./router";
import { callGeminiEmailBatch, callGeminiStatement } from "./providers/gemini";
import { callOpenAIEmailBatch, callOpenAIStatement } from "./providers/openai";
import { validateProviderResults } from "./validate";
import { recordSuccess, recordFailure, releaseHalfOpenProbe } from "./circuitBreaker";
import { estimateInputTokens, estimateOutputTokens, EmailInput, MAX_BATCH_SIZE } from "./prompts";
import { acquireIdempotencyKey, completeIdempotencyKey, failIdempotencyKey } from "./idempotency";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

async function logAttempt(
  ctx: LlmCallContext,
  batchKey: string | null,
  selected: SelectedProvider,
  outcome: string,
  latencyMs: number,
  inputTokens: number,
  outputTokens: number,
  errorDetail: string | null,
  opts: { attemptNumber: number; wasFallback: boolean; fallbackReason: string | null; candidateCount: number; finishReason?: string }
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
            : (process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
        candidateCount: opts.candidateCount,
        attemptNumber: opts.attemptNumber,
        wasFallback: opts.wasFallback,
        fallbackReason: opts.fallbackReason,
        outcome,
        errorDetail,
        finishReason: opts.finishReason ?? null,
        effectiveTimeoutMs: selected.effectiveTimeoutMs,
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

async function callProvider(selected: SelectedProvider, inputs: EmailInput[]) {
  if (selected.provider === "gemini") {
    return callGeminiEmailBatch(inputs, GEMINI_API_KEY, selected.effectiveTimeoutMs);
  }
  return callOpenAIEmailBatch(inputs, OPENAI_API_KEY, inputs.length, selected.effectiveTimeoutMs);
}

async function finalizeFailedAttempt(
  selected: SelectedProvider,
  err: unknown,
  ctx: LlmCallContext,
  batchKey: string | null,
  latencyMs: number,
  attemptNumber: number,
  wasFallback: boolean,
  fallbackReason: string | null,
  candidateCount: number,
): Promise<void> {
  const errDetail = err instanceof Error ? err.message : String(err);
  await logAttempt(ctx, batchKey, selected, "error", latencyMs, 0, 0, errDetail, {
    attemptNumber, wasFallback, fallbackReason, candidateCount,
  });
  if (isAvailabilityError(err)) {
    await recordFailure(selected.provider);
  }
  if (selected.isHalfOpenProbe) {
    await releaseHalfOpenProbe(selected.provider);
  }
  await releaseQuota(selected.provider, 1, selected.reservedInputTokens, selected.reservedOutputTokens);
}

export async function parseEmailBatchLLM(
  inputs: EmailInput[],
  batchKey: string,
  ctx: LlmCallContext,
  invocationDeadlineMs?: number
): Promise<ParsedEmailItem[]> {
  // If input exceeds MAX_BATCH_SIZE, split into micro-batches and merge results.
  // Limits blast radius: a malformed email in one micro-batch cannot affect others.
  if (inputs.length > MAX_BATCH_SIZE) {
    const allResults: ParsedEmailItem[] = [];
    for (let start = 0; start < inputs.length; start += MAX_BATCH_SIZE) {
      const slice = inputs.slice(start, start + MAX_BATCH_SIZE);
      const reindexed = slice.map((item, i) => ({ ...item, emailIndex: i }));
      const microKey = `${batchKey}:batch:${start}`;
      const microResults = await parseEmailBatchLLM(reindexed, microKey, ctx, invocationDeadlineMs);
      for (const r of microResults) {
        allResults.push({ ...r, emailIndex: r.emailIndex + start });
      }
    }
    return allResults;
  }

  const idempResult = await acquireIdempotencyKey(batchKey, invocationDeadlineMs);
  if (idempResult.status === "complete") {
    return idempResult.result;
  }

  const estimatedInput = estimateInputTokens(inputs);
  const estimatedOutput = estimateOutputTokens(inputs.length);

  let lastErr: unknown;
  let attemptNumber = 0;
  let fallbackReason: string | null = null;

  // Two attempts: primary provider, then fallback if the primary fails with an availability error.
  for (let i = 0; i < 2; i++) {
    attemptNumber = i + 1;
    const wasFallback = i > 0;

    let selected: SelectedProvider;
    try {
      selected = await selectProvider(inputs.length, estimatedInput, estimatedOutput, invocationDeadlineMs);
    } catch (routerErr) {
      // Both providers exhausted or budget too tight — fail fast
      await failIdempotencyKey(batchKey);
      throw routerErr;
    }

    const start = Date.now();
    try {
      const callResult = await callProvider(selected, inputs);
      const validated = validateProviderResults(callResult.items, inputs.length, selected.provider);
      const latencyMs = Date.now() - start;

      await logAttempt(ctx, batchKey, selected, "success", latencyMs, callResult.inputTokens, callResult.outputTokens, null, {
        attemptNumber, wasFallback, fallbackReason, candidateCount: inputs.length, finishReason: callResult.finishReason,
      });
      await recordSuccess(selected.provider);
      await completeIdempotencyKey(batchKey, validated);
      return validated;
    } catch (err) {
      const latencyMs = Date.now() - start;
      await finalizeFailedAttempt(
        selected, err, ctx, batchKey, latencyMs,
        attemptNumber, wasFallback, fallbackReason, inputs.length,
      );
      lastErr = err;
      fallbackReason = err instanceof Error ? err.name : "unknown";

      // Only retry on availability errors — contract/parse errors are batch-specific, retrying won't help
      const shouldRetry = isAvailabilityError(err) && !(err instanceof ProviderContractError);
      if (!shouldRetry) break;
    }
  }

  await failIdempotencyKey(batchKey);
  throw lastErr;
}

export async function parseStatementLLM(
  body: string,
  ctx: LlmCallContext,
  invocationDeadlineMs?: number
): Promise<StatementItem[]> {
  const estimatedInput = Math.ceil(body.length / 4);
  const estimatedOutput = 200;

  let lastErr: unknown;
  let fallbackReason: string | null = null;

  for (let i = 0; i < 2; i++) {
    const attemptNumber = i + 1;
    const wasFallback = i > 0;

    let selected: SelectedProvider;
    try {
      selected = await selectProvider(1, estimatedInput, estimatedOutput, invocationDeadlineMs);
    } catch (routerErr) {
      throw routerErr;
    }

    const start = Date.now();
    try {
      const result = selected.provider === "gemini"
        ? await callGeminiStatement(body, GEMINI_API_KEY, selected.effectiveTimeoutMs)
        : await callOpenAIStatement(body, OPENAI_API_KEY, selected.effectiveTimeoutMs);
      const latencyMs = Date.now() - start;

      await logAttempt(ctx, null, selected, "success", latencyMs, result.inputTokens, result.outputTokens, null, {
        attemptNumber, wasFallback, fallbackReason, candidateCount: 1,
      });
      await recordSuccess(selected.provider);
      return result.items;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errDetail = err instanceof Error ? err.message : String(err);
      await logAttempt(ctx, null, selected, "error", latencyMs, 0, 0, errDetail, {
        attemptNumber, wasFallback, fallbackReason, candidateCount: 1,
      });
      if (isAvailabilityError(err)) {
        await recordFailure(selected.provider);
      }
      lastErr = err;
      fallbackReason = err instanceof Error ? err.name : "unknown";

      if (!isAvailabilityError(err)) break;
    }
  }

  throw lastErr;
}
