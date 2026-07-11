import { prisma } from "@/lib/prisma";

const DAILY_LIMIT = 1400; // Buffer before 1500 hard limit

function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

export async function checkGeminiRateLimit(): Promise<{ allowed: boolean; resumesAt?: string }> {
  const today = todayUtc();
  const log = await prisma.geminiUsageLog.findUnique({ where: { date: today } });
  const count = log?.callCount ?? 0;
  if (count >= DAILY_LIMIT) {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return { allowed: false, resumesAt: tomorrow.toISOString() };
  }
  return { allowed: true };
}

export async function incrementGeminiUsage(): Promise<void> {
  const today = todayUtc();
  await prisma.geminiUsageLog.upsert({
    where: { date: today },
    create: { date: today, callCount: 1 },
    update: { callCount: { increment: 1 } },
  });
}
