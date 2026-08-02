import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { isScanRunStatus } from "@/lib/scan/types";
import type { CreateScanRequest, CreateScanResult } from "@/lib/scan/types";

export async function createScanRun(request: CreateScanRequest): Promise<CreateScanResult> {
  const {
    userId,
    gmailAccountId,
    clientRequestId,
    filterName,
    gmailQuery,
    fromDate,
    toDate,
    scanLimit,
  } = request;

  const existing = await prisma.emailScanRun.findFirst({
    where: { userId, clientRequestId },
    select: { id: true, status: true },
  });

  if (existing) {
    if (!isScanRunStatus(existing.status)) {
      throw new Error(`Invalid persisted scan status: ${existing.status}`);
    }
    return { scanRunId: existing.id, status: existing.status, created: false };
  }

  let scanRun: { id: string; status: string };
  try {
    scanRun = await prisma.$transaction(async (tx) => {
      const filter = await tx.userEmailFilter.create({
        data: { userId, gmailAccountId, name: filterName, isActive: true },
        select: { id: true },
      });

      const version = await tx.emailFilterVersion.create({
        data: {
          emailFilterId: filter.id,
          version: 1,
          gmailQuery,
          includeRulesJson: [],
          excludeRulesJson: [],
          ruleSchemaVersion: 1,
          filterEvaluatorVersion: 1,
          createdBy: userId,
        },
        select: { id: true },
      });

      await tx.userEmailFilter.update({
        where: { id: filter.id },
        data: { currentVersionId: version.id },
      });

      return tx.emailScanRun.create({
        data: {
          userId,
          gmailAccountId,
          clientRequestId,
          emailFilterId: filter.id,
          emailFilterVersionId: version.id,
          effectiveGmailQuery: gmailQuery,
          fromDate,
          toDate,
          ...(scanLimit !== undefined ? { scanLimit } : {}),
          filterRuleSchemaVersion: 1,
          filterEvaluatorVersion: 1,
          filterSnapshotJson: { gmailQuery, includeRules: [], excludeRules: [] },
          status: "CREATED",
        },
        select: { id: true, status: true },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const won = await prisma.emailScanRun.findFirst({
        where: { userId, clientRequestId },
        select: { id: true, status: true },
      });
      if (!won) throw err;
      if (!isScanRunStatus(won.status)) throw new Error(`Invalid persisted scan status: ${won.status}`);
      return { scanRunId: won.id, status: won.status, created: false };
    }
    throw err;
  }

  return { scanRunId: scanRun.id, status: "CREATED", created: true };
}
