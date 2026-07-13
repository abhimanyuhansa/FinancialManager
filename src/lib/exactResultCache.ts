import { prisma } from "@/lib/prisma";

export async function lookupExactCache(
  userId: string,
  gmailMsgIds: string[]
): Promise<Map<string, string>> {
  if (gmailMsgIds.length === 0) return new Map();

  const logs = await prisma.parseLog.findMany({
    where: {
      userId,
      gmailMsgId: { in: gmailMsgIds },
      transactionId: { not: null },
      outcome: { in: ["inserted", "upgraded", "skipped_duplicate"] },
    },
    select: { gmailMsgId: true, transactionId: true },
    orderBy: { createdAt: "desc" },
    distinct: ["gmailMsgId"],
  });

  const result = new Map<string, string>();
  for (const log of logs) {
    if (log.transactionId) result.set(log.gmailMsgId, log.transactionId);
  }
  return result;
}
