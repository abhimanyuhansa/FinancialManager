import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ParsedEmailItem } from "./providers/types";
import { randomUUID } from "crypto";

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
const IN_FLIGHT_TTL_MS = LLM_TIMEOUT_MS * 2 + 30_000;
const COMPLETE_TTL_MS = 86_400_000; // 24h
const FAILED_TTL_MS = 5_000;        // failed rows are re-claimable after 5s
const POLL_INTERVAL_MS = 2_000;

type IdempotencyResult =
  | { status: "claimed" }
  | { status: "complete"; result: ParsedEmailItem[] };

export async function acquireIdempotencyKey(
  batchKey: string,
  invocationDeadlineMs?: number,
): Promise<IdempotencyResult> {
  const inFlightExpiry = new Date(Date.now() + IN_FLIGHT_TTL_MS).toISOString();
  const id = randomUUID();

  // Atomic upsert: insert new in_flight row, or take over any expired/failed row,
  // or read back existing complete row.
  const rows = await prisma.$queryRaw<Array<{ status: string; result: unknown }>>(
    Prisma.sql`
      INSERT INTO "LlmBatchIdempotency" (id, "batchKey", status, result, "createdAt", "expiresAt")
      VALUES (${id}, ${batchKey}, 'in_flight', NULL, NOW(), ${inFlightExpiry}::timestamptz)
      ON CONFLICT ("batchKey")
      DO UPDATE SET
        id = ${id},
        status = 'in_flight',
        result = NULL,
        "expiresAt" = ${inFlightExpiry}::timestamptz
      WHERE "LlmBatchIdempotency"."expiresAt" < NOW()
      RETURNING status, result
    `
  );

  if (!rows.length) {
    // Conflict row exists and is NOT expired — poll for completion
    return pollForCompletion(batchKey, invocationDeadlineMs);
  }

  const row = rows[0];
  if (row.status === "complete") {
    return { status: "complete", result: row.result as ParsedEmailItem[] };
  }
  return { status: "claimed" };
}

async function pollForCompletion(
  batchKey: string,
  invocationDeadlineMs?: number,
): Promise<IdempotencyResult> {
  // Poll only until the invocation deadline (minus a small buffer), not the full LLM TTL.
  const pollDeadline = invocationDeadlineMs
    ? Math.min(invocationDeadlineMs - 3_000, Date.now() + IN_FLIGHT_TTL_MS + 5_000)
    : Date.now() + IN_FLIGHT_TTL_MS + 5_000;

  while (Date.now() < pollDeadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const rows = await prisma.$queryRaw<Array<{ status: string; result: unknown }>>(
      Prisma.sql`
        SELECT status, result FROM "LlmBatchIdempotency"
        WHERE "batchKey" = ${batchKey}
      `
    );
    if (!rows.length) {
      // Row expired or was deleted — try to claim fresh
      return acquireIdempotencyKey(batchKey, invocationDeadlineMs);
    }
    const row = rows[0];
    if (row.status === "complete") {
      return { status: "complete", result: row.result as ParsedEmailItem[] };
    }
    if (row.status === "failed") {
      // Previous owner failed — try to take over immediately
      return acquireIdempotencyKey(batchKey, invocationDeadlineMs);
    }
    // Still in_flight — keep polling
  }
  // Timed out — attempt takeover (expired row)
  return acquireIdempotencyKey(batchKey, invocationDeadlineMs);
}

export async function completeIdempotencyKey(
  batchKey: string,
  result: ParsedEmailItem[]
): Promise<void> {
  const completeExpiry = new Date(Date.now() + COMPLETE_TTL_MS).toISOString();
  try {
    await prisma.$queryRaw(
      Prisma.sql`
        UPDATE "LlmBatchIdempotency"
        SET
          status = 'complete',
          result = ${JSON.stringify(result)}::jsonb,
          "expiresAt" = ${completeExpiry}::timestamptz
        WHERE "batchKey" = ${batchKey} AND status = 'in_flight'
      `
    );
  } catch {
    // Best-effort — failure here doesn't affect the caller's result
  }
}

export async function failIdempotencyKey(batchKey: string): Promise<void> {
  const failedExpiry = new Date(Date.now() + FAILED_TTL_MS).toISOString();
  try {
    await prisma.$queryRaw(
      Prisma.sql`
        UPDATE "LlmBatchIdempotency"
        SET status = 'failed', "expiresAt" = ${failedExpiry}::timestamptz
        WHERE "batchKey" = ${batchKey} AND status = 'in_flight'
      `
    );
  } catch {
    // Best-effort
  }
}
