import { LLMProvider, ProviderExhaustedError } from "./providers/types";
import { checkQuota, reserveQuota, releaseQuota } from "./quota";
import {
  getCircuitBreakerState,
  tryAcquireHalfOpenProbe,
  releaseHalfOpenProbe,
  CircuitState,
} from "./circuitBreaker";

export type SelectedProvider = {
  provider: LLMProvider;
  isHalfOpenProbe: boolean;
  reservedInputTokens: number;
  reservedOutputTokens: number;
};

function getPrimaryProvider(_candidateCount: number): LLMProvider {
  // Gemini (gemini-3.1-flash-lite) is always primary: 2-10s vs gpt-4o-mini's 5-35s for our batch sizes.
  // OpenAI is the fallback. Override with LLM_PRIMARY_PROVIDER env var if needed.
  return (process.env.LLM_PRIMARY_PROVIDER as LLMProvider | undefined) ?? "gemini";
}

function getFallbackProvider(primary: LLMProvider): LLMProvider {
  return primary === "gemini" ? "openai" : "gemini";
}

async function tryReserve(
  provider: LLMProvider,
  state: CircuitState,
  quotaAllowed: boolean,
  inputTokens: number,
  outputTokens: number
): Promise<SelectedProvider | null> {
  if (!quotaAllowed || state === "OPEN") return null;

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

  return { provider, isHalfOpenProbe, reservedInputTokens: inputTokens, reservedOutputTokens: outputTokens };
}

export async function selectProvider(
  candidateCount: number,
  estimatedInputTokens: number,
  estimatedOutputTokens: number
): Promise<SelectedProvider> {
  const primary = getPrimaryProvider(candidateCount);
  const fallback = getFallbackProvider(primary);

  // Phase 1: read-only checks for both providers in parallel
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

  // Phase 2: single atomic reserve+probe for chosen provider
  const primaryResult = await tryReserve(
    primary, primaryState, primaryQuota.allowed,
    estimatedInputTokens, estimatedOutputTokens
  );
  if (primaryResult) return primaryResult;

  const fallbackResult = await tryReserve(
    fallback, fallbackState, fallbackQuota.allowed,
    estimatedInputTokens, estimatedOutputTokens
  );
  if (fallbackResult) return fallbackResult;

  throw new ProviderExhaustedError(primary, fallback);
}

export { releaseQuota };
