import type { Prisma } from "@prisma/client";

export const UNPARSED_LLM_DISABLED = "unparsed_llm_disabled";

type DeterministicMiss = {
  msgId: string;
  senderDomain: string;
  receivedDate: string;
  body: string;
  bodyLengthRaw: number;
  bodyWasTruncated: boolean;
};

export function buildLlmDisabledParseLogs(
  emails: DeterministicMiss[],
  job: { id: string; userId: string },
): Prisma.ParseLogCreateManyInput[] {
  return emails.map((email) => ({
    userId: job.userId,
    syncJobId: job.id,
    gmailMsgId: email.msgId,
    senderDomain: email.senderDomain,
    emailDate: new Date(email.receivedDate),
    bodyLengthRaw: email.bodyLengthRaw,
    bodyLengthSent: 0,
    wasTruncated: email.bodyWasTruncated,
    batchSize: 1,
    outcome: UNPARSED_LLM_DISABLED,
    resolvedBy: "llm_disabled",
  }));
}

export function deduplicateLlmDisabledParseLogs(
  logs: Prisma.ParseLogCreateManyInput[],
  existingMessageIds: ReadonlySet<string>,
): Prisma.ParseLogCreateManyInput[] {
  const seenMessageIds = new Set(existingMessageIds);

  return logs.filter((log) => {
    if (log.outcome !== UNPARSED_LLM_DISABLED) return true;
    if (seenMessageIds.has(log.gmailMsgId)) return false;
    seenMessageIds.add(log.gmailMsgId);
    return true;
  });
}
