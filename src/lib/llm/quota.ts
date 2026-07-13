import { prisma } from "@/lib/prisma";
import { LLMProvider } from "./providers/types";
import { Prisma } from "@prisma/client";

const LIMITS: Record<LLMProvider, { rpm: number; tpm: number; rpd: number }> = {
  gemini: {
    rpm: Number(process.env.GEMINI_RPM_LIMIT ?? 12),
    tpm: Number(process.env.GEMINI_TPM_LIMIT ?? 32_000),
    rpd: Number(process.env.GEMINI_RPD_LIMIT ?? 1_120),
  },
  openai: {
    rpm: Number(process.env.OPENAI_RPM_LIMIT ?? 480),
    tpm: Number(process.env.OPENAI_TPM_LIMIT ?? 160_000),
    rpd: Number(process.env.OPENAI_RPD_LIMIT ?? 9_000),
  },
};

function windowKeys(): { rpm: string; tpm: string; rpd: string } {
  const now = new Date();
  const minuteKey = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const dayKey = now.toISOString().slice(0, 10);    // YYYY-MM-DD
  return { rpm: minuteKey, tpm: minuteKey, rpd: dayKey };
}

type WindowRow = { windowType: string; count: number };

export async function checkQuota(
  provider: LLMProvider,
  requestCount: number
): Promise<{ allowed: boolean; reason?: string }> {
  const keys = windowKeys();
  const limits = LIMITS[provider];

  const rows = await prisma.$queryRaw<WindowRow[]>(
    Prisma.sql`
      SELECT "windowType", count FROM "LlmQuotaWindow"
      WHERE provider = ${provider}
        AND (
          ("windowType" = 'rpm' AND "windowKey" = ${keys.rpm})
          OR ("windowType" = 'tpm' AND "windowKey" = ${keys.tpm})
          OR ("windowType" = 'rpd' AND "windowKey" = ${keys.rpd})
        )
    `
  );

  const get = (type: string) =>
    rows.find((r) => r.windowType === type)?.count ?? 0;

  if (get("rpm") + requestCount > limits.rpm)
    return { allowed: false, reason: `rpm limit ${limits.rpm}` };
  if (get("rpd") + requestCount > limits.rpd)
    return { allowed: false, reason: `rpd limit ${limits.rpd}` };
  return { allowed: true };
}

export async function reserveQuota(
  provider: LLMProvider,
  requestCount: number,
  inputTokens: number,
  outputTokens: number
): Promise<boolean> {
  const keys = windowKeys();
  const limits = LIMITS[provider];

  const windows = [
    { type: "rpm", key: keys.rpm, delta: requestCount, limit: limits.rpm },
    { type: "tpm", key: keys.tpm, delta: inputTokens + outputTokens, limit: limits.tpm },
    { type: "rpd", key: keys.rpd, delta: requestCount, limit: limits.rpd },
  ];

  for (const w of windows) {
    const result = await prisma.$queryRaw<Array<{ affected: number }>>(
      Prisma.sql`
        INSERT INTO "LlmQuotaWindow" (id, provider, "windowType", "windowKey", count, "updatedAt")
        VALUES (gen_random_uuid(), ${provider}, ${w.type}, ${w.key}, ${w.delta}, NOW())
        ON CONFLICT (provider, "windowType", "windowKey")
        DO UPDATE SET
          count = "LlmQuotaWindow".count + ${w.delta},
          "updatedAt" = NOW()
        WHERE "LlmQuotaWindow".count + ${w.delta} <= ${w.limit}
        RETURNING 1 AS affected
      `
    );
    if (!result.length) return false;
  }
  return true;
}

export async function releaseQuota(
  provider: LLMProvider,
  requestCount: number,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const keys = windowKeys();

  const windows = [
    { type: "rpm", key: keys.rpm, delta: requestCount },
    { type: "tpm", key: keys.tpm, delta: inputTokens + outputTokens },
    { type: "rpd", key: keys.rpd, delta: requestCount },
  ];

  try {
    for (const w of windows) {
      await prisma.$queryRaw(
        Prisma.sql`
          UPDATE "LlmQuotaWindow"
          SET count = GREATEST(0, count - ${w.delta}), "updatedAt" = NOW()
          WHERE provider = ${provider}
            AND "windowType" = ${w.type}
            AND "windowKey" = ${w.key}
        `
      );
    }
  } catch {
    // Best-effort — quota release failure is not fatal
  }
}
