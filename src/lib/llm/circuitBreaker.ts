import { prisma } from "@/lib/prisma";
import { LLMProvider } from "./providers/types";
import { Prisma } from "@prisma/client";

const FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? 3);
const HALF_OPEN_AFTER_MS = Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_MS ?? 60_000);

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export async function getCircuitBreakerState(provider: LLMProvider): Promise<CircuitState> {
  const row = await prisma.llmCircuitBreaker.findUnique({ where: { provider } });
  if (!row || row.state === "CLOSED") return "CLOSED";
  // PROBING = a half-open probe is in flight; treat as HALF_OPEN so the caller
  // sees it as contested and does NOT try to acquire another probe.
  if (row.state === "PROBING") return "HALF_OPEN";
  if (row.state === "OPEN" && row.openedAt) {
    const elapsed = Date.now() - row.openedAt.getTime();
    if (elapsed >= HALF_OPEN_AFTER_MS) return "HALF_OPEN";
    return "OPEN";
  }
  return row.state as CircuitState;
}

export async function recordSuccess(provider: LLMProvider): Promise<void> {
  await prisma.llmCircuitBreaker.upsert({
    where: { provider },
    create: { provider, state: "CLOSED", consecutiveFailures: 0 },
    update: { state: "CLOSED", consecutiveFailures: 0, openedAt: null, lastFailureAt: null },
  });
}

export async function recordFailure(provider: LLMProvider): Promise<void> {
  await prisma.llmCircuitBreaker.upsert({
    where: { provider },
    create: { provider, state: "CLOSED", consecutiveFailures: 1, lastFailureAt: new Date() },
    update: {
      consecutiveFailures: { increment: 1 },
      lastFailureAt: new Date(),
    },
  });

  const row = await prisma.llmCircuitBreaker.findUnique({ where: { provider } });
  if (row && row.consecutiveFailures >= FAILURE_THRESHOLD) {
    await prisma.llmCircuitBreaker.update({
      where: { provider },
      // Reset consecutiveFailures so the next CLOSED period needs FAILURE_THRESHOLD fresh failures
      data: { state: "OPEN", openedAt: new Date(), consecutiveFailures: 0 },
    });
  }
}

export async function tryAcquireHalfOpenProbe(provider: LLMProvider): Promise<boolean> {
  const result = await prisma.$queryRaw<Array<{ affected: number }>>(
    Prisma.sql`
      UPDATE "LlmCircuitBreaker"
      SET state = 'PROBING', "updatedAt" = NOW()
      WHERE provider = ${provider}
        AND state = 'OPEN'
        AND "openedAt" IS NOT NULL
        AND EXTRACT(EPOCH FROM (NOW() - "openedAt")) * 1000 >= ${HALF_OPEN_AFTER_MS}
      RETURNING 1 AS affected
    `
  );
  return result.length > 0;
}

export async function releaseHalfOpenProbe(provider: LLMProvider): Promise<void> {
  await prisma.llmCircuitBreaker.updateMany({
    where: { provider, state: "PROBING" },
    // Reset consecutiveFailures so the OPEN→HALF_OPEN cycle starts fresh next time
    data: { state: "OPEN", consecutiveFailures: 0 },
  });
}
