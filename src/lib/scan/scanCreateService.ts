import { prisma } from "@/lib/prisma";
import { isScanRunStatus } from "@/lib/scan/types";
import type { CreateScanRequest, CreateScanResult } from "@/lib/scan/types";

export type ScanCreateStore = {
  emailScanRun: {
    findFirst(args: unknown): Promise<{ id: string; status: string } | null>;
    create(args: unknown): Promise<{ id: string; status: string }>;
  };
  userEmailFilter: {
    create(args: unknown): Promise<{ id: string }>;
  };
  emailFilterVersion: {
    create(args: unknown): Promise<{ id: string }>;
  };
  userEmailFilter_setCurrentVersion(filterId: string, versionId: string): Promise<void>;
};

function makeDefaultStore(): ScanCreateStore {
  return {
    emailScanRun: {
      findFirst: (args) =>
        prisma.emailScanRun.findFirst(
          args as Parameters<typeof prisma.emailScanRun.findFirst>[0],
        ),
      create: (args) =>
        prisma.emailScanRun.create(
          args as Parameters<typeof prisma.emailScanRun.create>[0],
        ),
    },
    userEmailFilter: {
      create: (args) =>
        prisma.userEmailFilter.create(
          args as Parameters<typeof prisma.userEmailFilter.create>[0],
        ),
    },
    emailFilterVersion: {
      create: (args) =>
        prisma.emailFilterVersion.create(
          args as Parameters<typeof prisma.emailFilterVersion.create>[0],
        ),
    },
    userEmailFilter_setCurrentVersion: async (filterId, versionId) => {
      await prisma.userEmailFilter.update({
        where: { id: filterId },
        data: { currentVersionId: versionId },
      });
    },
  };
}

export async function createScanRun(
  request: CreateScanRequest,
  store: ScanCreateStore = makeDefaultStore(),
): Promise<CreateScanResult> {
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

  const existing = await store.emailScanRun.findFirst({
    where: { userId, clientRequestId },
    select: { id: true, status: true },
  });

  if (existing) {
    if (!isScanRunStatus(existing.status)) {
      throw new Error(`Invalid persisted scan status: ${existing.status}`);
    }
    return { scanRunId: existing.id, status: existing.status, created: false };
  }

  const filter = await store.userEmailFilter.create({
    data: { userId, gmailAccountId, name: filterName, isActive: true },
    select: { id: true },
  });

  const version = await store.emailFilterVersion.create({
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

  await store.userEmailFilter_setCurrentVersion(filter.id, version.id);

  const scanRun = await store.emailScanRun.create({
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

  return { scanRunId: scanRun.id, status: "CREATED", created: true };
}
