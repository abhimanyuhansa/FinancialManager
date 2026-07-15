import { prisma } from "@/lib/prisma";
import { LLMProvider } from "./providers/types";
import { Prisma } from "@prisma/client";

const FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? 3);
const HALF_OPEN_AFTER_MS = Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_MS ?? 60_000);
// Probe lease must exceed the max provider timeout so the probe can complete before expiry.
// Defaults to 2 × LLM_TIMEOUT_MS + 30s buffer.
const PROBE_LEASE_MS = Number(process.env.CIRCUIT_BREAKER_PROBE_LEASE_MS
  ?? (Number(process.env.LLM_TIMEOUT_MS ?? 30_000) * 2 + 30_000));

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export async function getCircuitBreakerState(provider: LLMProvider): Promise<CircuitState> {
  const row = await prisma.llmCircuitBreaker.findUnique({ where: { provider } });
  if (!row || row.state === "CLOSED") return "CLOSED";
  // PROBING = a half-open probe is in flight. Regardless of lease expiry we return
  // HALF_OPEN so tryAcquireHalfOpenProbe decides whether to block or reclaim.
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
    update: {
      state: "CLOSED",
      consecutiveFailures: 0,
      openedAt: null,
      lastFailureAt: null,
      probeLeaseExpiresAt: null,
    },
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
      data: {
        state: "OPEN",
        openedAt: new Date(),
        consecutiveFailures: 0,
        probeLeaseExpiresAt: null,
      },
    });
  }
}

export async function tryAcquireHalfOpenProbe(provider: LLMProvider): Promise<boolean> {
  const leaseExpiry = new Date(Date.now() + PROBE_LEASE_MS).toISOString();

  // Attempt 1: transition from OPEN → PROBING (normal half-open probe acquisition)
  const fromOpen = await prisma.$queryRaw<Array<{ affected: number }>>(
    Prisma.sql`
      UPDATE "LlmCircuitBreaker"
      SET state = 'PROBING',
          "probeLeaseExpiresAt" = ${leaseExpiry}::timestamptz,
          "updatedAt" = NOW()
      WHERE provider = ${provider}
        AND state = 'OPEN'
        AND "openedAt" IS NOT NULL
        AND EXTRACT(EPOCH FROM (NOW() - "openedAt")) * 1000 >= ${HALF_OPEN_AFTER_MS}
      RETURNING 1 AS affected
    `
  );
  if (fromOpen.length > 0) return true;

  // Attempt 2: reclaim an expired PROBING lease (previous probe holder crashed/timed out)
  const reclaim = await prisma.$queryRaw<Array<{ affected: number }>>(
    Prisma.sql`
      UPDATE "LlmCircuitBreaker"
      SET "probeLeaseExpiresAt" = ${leaseExpiry}::timestamptz,
          "updatedAt" = NOW()
      WHERE provider = ${provider}
        AND state = 'PROBING'
        AND "probeLeaseExpiresAt" IS NOT NULL
        AND "probeLeaseExpiresAt" < NOW()
      RETURNING 1 AS affected
    `
  );
  return reclaim.length > 0;
}

export async function releaseHalfOpenProbe(provider: LLMProvider): Promise<void> {
  await prisma.llmCircuitBreaker.updateMany({
    where: { provider, state: "PROBING" },
    data: { state: "OPEN", consecutiveFailures: 0, probeLeaseExpiresAt: null },
  });
}
