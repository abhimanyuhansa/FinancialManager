import { prisma } from "@/lib/prisma";
import {
  ParsedEmailItem,
  StatementItem,
  LlmCallContext,
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

async function logAttempt(
  ctx: LlmCallContext,
  batchKey: string | null,
  selected: SelectedProvider,
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
            : (process.env.OPENAI_MODEL ?? "gpt-4o-mini"),
        candidateCount: 0,
        attemptNumber: 1,
        wasFallback: false,
        fallbackReason: null,
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
  selected: SelectedProvider,
  inputs: EmailInput[]
) {
  if (selected.provider === "gemini") {
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

  const start = Date.now();
  try {
    const callResult = await callProvider(selected, inputs);
    const validated = validateProviderResults(callResult.items, inputs.length, selected.provider);
    const latencyMs = Date.now() - start;

    await logAttempt(ctx, batchKey, selected, "success", latencyMs, callResult.inputTokens, callResult.outputTokens, null);
    await recordSuccess(selected.provider);
    await completeIdempotencyKey(batchKey, validated);
    return validated;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errDetail = err instanceof Error ? err.message : String(err);

    await logAttempt(ctx, batchKey, selected, "error", latencyMs, 0, 0, errDetail);
    await recordFailure(selected.provider);
    if (selected.isHalfOpenProbe) {
      await releaseHalfOpenProbe(selected.provider);
    }
    // Release reserved quota so the next tick can reserve it for a fresh attempt.
    await releaseQuota(selected.provider, 1, selected.reservedInputTokens, selected.reservedOutputTokens);
    throw err;
  }
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
    const result = selected.provider === "gemini"
      ? await callGeminiStatement(body, GEMINI_API_KEY)
      : await callOpenAIStatement(body, OPENAI_API_KEY);
    const latencyMs = Date.now() - start;

    await logAttempt(ctx, null, selected, "success", latencyMs, result.inputTokens, result.outputTokens, null);
    await recordSuccess(selected.provider);
    return result.items;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errDetail = err instanceof Error ? err.message : String(err);
    await logAttempt(ctx, null, selected, "error", latencyMs, 0, 0, errDetail);
    await recordFailure(selected.provider);
    throw err;
  }
}
