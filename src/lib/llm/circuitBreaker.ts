import { prisma } from "@/lib/prisma";
import { LLMProvider } from "./providers/types";
import { Prisma } from "@prisma/client";

const FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? 3);
const HALF_OPEN_AFTER_MS = Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_MS ?? 60_000);

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export async function getCircuitBreakerState(provider: LLMProvider): Promise<CircuitState> {
  const row = await prisma.llmCircuitBreaker.findUnique({ where: { provider } });
  if (!row || row.state === "CLOSED") return "CLOSED";
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
      data: { state: "OPEN", openedAt: new Date() },
    });
  }
}

export async function tryAcquireHalfOpenProbe(provider: LLMProvider): Promise<boolean> {
  const result = await prisma.$queryRaw<Array<{ affected: number }>>(
    Prisma.sql`
      UPDATE "LlmCircuitBreaker"
      SET state = 'PROBING', updated_at = NOW()
      WHERE provider = ${provider}
        AND state = 'OPEN'
        AND opened_at IS NOT NULL
        AND EXTRACT(EPOCH FROM (NOW() - opened_at)) * 1000 >= ${HALF_OPEN_AFTER_MS}
      RETURNING 1 AS affected
    `
  );
  return result.length > 0;
}

export async function releaseHalfOpenProbe(provider: LLMProvider): Promise<void> {
  await prisma.llmCircuitBreaker.updateMany({
    where: { provider, state: "PROBING" },
    data: { state: "OPEN" },
  });
}
