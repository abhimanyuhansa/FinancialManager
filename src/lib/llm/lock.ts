import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

const LOCK_DURATION_MS = Number(process.env.SYNC_LOCK_DURATION_MS ?? 30_000);
const HEARTBEAT_INTERVAL_MS = Math.floor(LOCK_DURATION_MS * 0.4);

export class LockLostError extends Error {
  readonly name = "LockLostError" as const;
  constructor(jobId: string) {
    super(`Lock lost for jobId=${jobId}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type LockContext = {
  ownerToken: string;
  lockLost: { value: boolean };
  release: () => void;
};

type AcquireOptions = {
  maxRetries?: number;
  retryDelayMs?: number;
};

export async function acquireLock(
  jobId: string,
  opts: AcquireOptions = {}
): Promise<LockContext> {
  const { maxRetries = 5, retryDelayMs = 2_000 } = opts;
  const ownerToken = randomUUID();
  const lockLost = { value: false };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await prisma.$queryRaw<Array<{ acquired: boolean }>>(
      Prisma.sql`
        INSERT INTO "SyncJobLock" (job_id, owner_token, locked_at, expires_at)
        VALUES (
          ${jobId},
          ${ownerToken},
          NOW(),
          NOW() + (${LOCK_DURATION_MS}::bigint * INTERVAL '1 millisecond')
        )
        ON CONFLICT (job_id)
        DO UPDATE SET
          owner_token = ${ownerToken},
          locked_at = NOW(),
          expires_at = NOW() + (${LOCK_DURATION_MS}::bigint * INTERVAL '1 millisecond')
        WHERE "SyncJobLock".expires_at < NOW()
        RETURNING TRUE AS acquired
      `
    );

    if (result.length > 0) {
      const heartbeat = setInterval(async () => {
        try {
          const renewed = await prisma.$queryRaw<Array<{ renewed: boolean }>>(
            Prisma.sql`
              UPDATE "SyncJobLock"
              SET expires_at = NOW() + (${LOCK_DURATION_MS}::bigint * INTERVAL '1 millisecond')
              WHERE job_id = ${jobId} AND owner_token = ${ownerToken}
              RETURNING TRUE AS renewed
            `
          );
          if (!renewed.length) {
            lockLost.value = true;
            clearInterval(heartbeat);
          }
        } catch {
          lockLost.value = true;
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_INTERVAL_MS);

      const release = () => {
        clearInterval(heartbeat);
        releaseLock(jobId, ownerToken).catch(() => {});
      };

      return { ownerToken, lockLost, release };
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  throw new Error(`Could not acquire lock for jobId=${jobId} after ${maxRetries} retries`);
}

export async function releaseLock(jobId: string, ownerToken: string): Promise<void> {
  try {
    await prisma.$queryRaw(
      Prisma.sql`
        DELETE FROM "SyncJobLock"
        WHERE job_id = ${jobId} AND owner_token = ${ownerToken}
      `
    );
  } catch {
    // Best-effort
  }
}
