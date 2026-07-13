import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ParsedEmailItem } from "./providers/types";
import { randomUUID } from "crypto";

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
const IN_FLIGHT_TTL_MS = LLM_TIMEOUT_MS * 2 + 30_000;
const COMPLETE_TTL_MS = 86_400_000; // 24h
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_WAIT_MS = IN_FLIGHT_TTL_MS + 5_000;

type IdempotencyResult =
  | { status: "claimed" }
  | { status: "complete"; result: ParsedEmailItem[] };

export async function acquireIdempotencyKey(batchKey: string): Promise<IdempotencyResult> {
  const inFlightExpiry = new Date(Date.now() + IN_FLIGHT_TTL_MS).toISOString();
  const id = randomUUID();

  // Atomic upsert: insert new in_flight row, or take over expired row,
  // or read back existing complete row. The RETURNING clause gives us the
  // winning row's status+result so we know whether we claimed or hit a cache.
  const rows = await prisma.$queryRaw<Array<{ status: string; result: unknown }>>(
    Prisma.sql`
      INSERT INTO "LlmBatchIdempotency" (id, batch_key, status, result, created_at, expires_at)
      VALUES (${id}, ${batchKey}, 'in_flight', NULL, NOW(), ${inFlightExpiry}::timestamptz)
      ON CONFLICT (batch_key)
      DO UPDATE SET
        id = ${id},
        status = 'in_flight',
        result = NULL,
        expires_at = ${inFlightExpiry}::timestamptz
      WHERE "LlmBatchIdempotency".expires_at < NOW()
      RETURNING status, result
    `
  );

  if (!rows.length) {
    // Conflict row exists and is NOT expired — poll for completion
    return pollForCompletion(batchKey);
  }

  const row = rows[0];
  if (row.status === "complete") {
    return { status: "complete", result: row.result as ParsedEmailItem[] };
  }
  return { status: "claimed" };
}

async function pollForCompletion(batchKey: string): Promise<IdempotencyResult> {
  const deadline = Date.now() + POLL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const rows = await prisma.$queryRaw<Array<{ status: string; result: unknown }>>(
      Prisma.sql`
        SELECT status, result FROM "LlmBatchIdempotency"
        WHERE batch_key = ${batchKey}
      `
    );
    if (!rows.length) {
      // Row expired or was deleted — try to claim fresh
      return acquireIdempotencyKey(batchKey);
    }
    const row = rows[0];
    if (row.status === "complete") {
      return { status: "complete", result: row.result as ParsedEmailItem[] };
    }
    // Still in_flight — keep polling
  }
  // Timed out — attempt takeover (expired row)
  return acquireIdempotencyKey(batchKey);
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
          expires_at = ${completeExpiry}::timestamptz
        WHERE batch_key = ${batchKey} AND status = 'in_flight'
      `
    );
  } catch {
    // Best-effort — failure here doesn't affect the caller's result
  }
}
