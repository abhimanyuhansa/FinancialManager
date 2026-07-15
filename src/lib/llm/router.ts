import { LLMProvider, ProviderExhaustedError } from "./providers/types";
import { checkQuota, reserveQuota, releaseQuota } from "./quota";
import {
  getCircuitBreakerState,
  tryAcquireHalfOpenProbe,
  releaseHalfOpenProbe,
  CircuitState,
} from "./circuitBreaker";

// How many ms to reserve for DB writes + cleanup after the LLM call returns
const DB_AND_CLEANUP_RESERVE_MS = 8_000;
// Don't bother selecting a provider if we can't give it at least this much time
const MIN_PROVIDER_BUDGET_MS = 5_000;

const DEFAULT_GEMINI_TIMEOUT_MS = Number(
  process.env.GEMINI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS ?? 30_000
);
const DEFAULT_OPENAI_TIMEOUT_MS = Number(
  process.env.OPENAI_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS ?? 30_000
);

const PROVIDER_DEFAULT_TIMEOUT: Record<LLMProvider, number> = {
  gemini: DEFAULT_GEMINI_TIMEOUT_MS,
  openai: DEFAULT_OPENAI_TIMEOUT_MS,
};

export type SelectedProvider = {
  provider: LLMProvider;
  isHalfOpenProbe: boolean;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  effectiveTimeoutMs: number;
};

function getPrimaryProvider(_candidateCount: number): LLMProvider {
  return (process.env.LLM_PRIMARY_PROVIDER as LLMProvider | undefined) ?? "gemini";
}

function getFallbackProvider(primary: LLMProvider): LLMProvider {
  return primary === "gemini" ? "openai" : "gemini";
}

function computeEffectiveTimeout(provider: LLMProvider, invocationDeadlineMs?: number): number {
  const configured = PROVIDER_DEFAULT_TIMEOUT[provider];
  if (!invocationDeadlineMs) return configured;
  const remaining = invocationDeadlineMs - Date.now() - DB_AND_CLEANUP_RESERVE_MS;
  return Math.min(configured, remaining);
}

async function tryReserve(
  provider: LLMProvider,
  state: CircuitState,
  quotaAllowed: boolean,
  inputTokens: number,
  outputTokens: number,
  invocationDeadlineMs?: number
): Promise<SelectedProvider | null> {
  if (!quotaAllowed || state === "OPEN") return null;

  const effectiveTimeoutMs = computeEffectiveTimeout(provider, invocationDeadlineMs);
  if (effectiveTimeoutMs < MIN_PROVIDER_BUDGET_MS) return null;

  let isHalfOpenProbe = false;
  if (state === "HALF_OPEN") {
    const acquired = await tryAcquireHalfOpenProbe(provider);
    if (!acquired) return null;
    isHalfOpenProbe = true;
  }

  const reserved = await reserveQuota(provider, 1, inputTokens, outputTokens);
  if (!reserved) {
    if (isHalfOpenProbe) await releaseHalfOpenProbe(provider);
    return null;
  }

  return { provider, isHalfOpenProbe, reservedInputTokens: inputTokens, reservedOutputTokens: outputTokens, effectiveTimeoutMs };
}

export async function selectProvider(
  candidateCount: number,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
  invocationDeadlineMs?: number
): Promise<SelectedProvider> {
  const primary = getPrimaryProvider(candidateCount);
  const fallback = getFallbackProvider(primary);

  const [primaryState, fallbackState] = await Promise.all([
    getCircuitBreakerState(primary),
    getCircuitBreakerState(fallback),
  ]);

  const [primaryQuota, fallbackQuota] = await Promise.all([
    primaryState !== "OPEN"
      ? checkQuota(primary, 1)
      : Promise.resolve({ allowed: false, reason: "circuit open" }),
    fallbackState !== "OPEN"
      ? checkQuota(fallback, 1)
      : Promise.resolve({ allowed: false, reason: "circuit open" }),
  ]);

  const primaryResult = await tryReserve(
    primary, primaryState, primaryQuota.allowed,
    estimatedInputTokens, estimatedOutputTokens, invocationDeadlineMs
  );
  if (primaryResult) return primaryResult;

  const fallbackResult = await tryReserve(
    fallback, fallbackState, fallbackQuota.allowed,
    estimatedInputTokens, estimatedOutputTokens, invocationDeadlineMs
  );
  if (fallbackResult) return fallbackResult;

  throw new ProviderExhaustedError(primary, fallback);
}

export { releaseQuota };
