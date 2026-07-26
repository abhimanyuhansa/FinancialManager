import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { buildScanFromDate, type LookbackPeriod } from "@/lib/gmail";
import {
  SUPPORTED_FILTER_EVALUATOR_VERSION,
  SUPPORTED_RULE_SCHEMA_VERSION,
  type EmailFilterRule,
  validateFilterRules,
} from "@/lib/scan/filterEvaluator";
import {
  type SchedulerService,
  type ScanWorkerMessage,
  workerDeduplicationId,
} from "@/lib/scan/scheduler";

const DEFAULT_GMAIL_QUERY =
  "in:inbox -category:promotions -category:social -category:forums";

type FilterSnapshotRecord = {
  filterId: string;
  versionId: string;
  gmailQuery: string;
  includeRules: EmailFilterRule[];
  excludeRules: EmailFilterRule[];
  ruleSchemaVersion: number;
  evaluatorVersion: number;
};

async function getOrCreateDefaultFilter(
  userId: string,
  gmailAccountId: string,
): Promise<FilterSnapshotRecord> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.userEmailFilter.findFirst({
      where: {
        userId,
        gmailAccountId,
        isActive: true,
        currentVersionId: { not: null },
      },
      include: { currentVersion: true },
      orderBy: { createdAt: "asc" },
    });
    if (existing?.currentVersion) {
      const rules = validateFilterRules(
        existing.currentVersion.includeRulesJson,
        existing.currentVersion.excludeRulesJson,
      );
      return {
        filterId: existing.id,
        versionId: existing.currentVersion.id,
        gmailQuery: existing.currentVersion.gmailQuery,
        includeRules: rules.includeRules,
        excludeRules: rules.excludeRules,
        ruleSchemaVersion: existing.currentVersion.ruleSchemaVersion,
        evaluatorVersion: existing.currentVersion.filterEvaluatorVersion,
      };
    }

    const filter = await tx.userEmailFilter.create({
      data: {
        userId,
        gmailAccountId,
        name: "Default Gmail inventory",
        isActive: true,
      },
    });
    const version = await tx.emailFilterVersion.create({
      data: {
        emailFilterId: filter.id,
        version: 1,
        gmailQuery: DEFAULT_GMAIL_QUERY,
        includeRulesJson: [],
        excludeRulesJson: [],
        ruleSchemaVersion: SUPPORTED_RULE_SCHEMA_VERSION,
        filterEvaluatorVersion: SUPPORTED_FILTER_EVALUATOR_VERSION,
        createdBy: userId,
      },
    });
    await tx.userEmailFilter.update({
      where: { id: filter.id },
      data: { currentVersionId: version.id, updatedAt: new Date() },
    });

    return {
      filterId: filter.id,
      versionId: version.id,
      gmailQuery: version.gmailQuery,
      includeRules: [],
      excludeRules: [],
      ruleSchemaVersion: version.ruleSchemaVersion,
      evaluatorVersion: version.filterEvaluatorVersion,
    };
  });
}

export type CreateScanInput = {
  userId: string;
  clientRequestId?: string;
  period?: LookbackPeriod;
};

export function resolvePhase1aScanStart(
  lastSuccessfulCreatedAt: Date | null,
  period: LookbackPeriod,
  now: Date,
) {
  return lastSuccessfulCreatedAt
    ? new Date(lastSuccessfulCreatedAt.getTime() - 60_000)
    : buildScanFromDate(period, now);
}

export async function createScan(
  input: CreateScanInput,
  scheduler: SchedulerService,
) {
  const clientRequestId = input.clientRequestId ?? randomUUID();
  const existing = await prisma.emailScanRun.findFirst({
    where: { userId: input.userId, clientRequestId },
  });
  if (existing) {
    return {
      scanRunId: existing.id,
      clientRequestId,
      schedulingStatus: existing.pendingContinuationPublishedAt
        ? "SCHEDULED"
        : "PENDING_RETRY",
      idempotentReplay: true,
    };
  }

  const active = await prisma.emailScanRun.findFirst({
    where: {
      userId: input.userId,
      status: {
        in: ["CREATED", "DISCOVERING", "FETCHING", "RETRY_WAIT", "PAUSED", "CANCELLING"],
      },
    },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    return {
      scanRunId: active.id,
      clientRequestId: active.clientRequestId,
      schedulingStatus: active.pendingContinuationPublishedAt
        ? "SCHEDULED"
        : "PENDING_RETRY",
      idempotentReplay: false,
      reusedActiveScan: true,
    };
  }

  const account = await prisma.account.findFirst({
    where: {
      userId: input.userId,
      provider: "google",
      disconnectedAt: null,
    },
    select: { id: true },
  });
  if (!account) throw new Error("No connected Gmail account");

  const filter = await getOrCreateDefaultFilter(input.userId, account.id);
  const now = new Date();
  const lastSuccessful = await prisma.emailScanRun.findFirst({
    where: {
      userId: input.userId,
      gmailAccountId: account.id,
      status: { in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  // A short overlap protects messages received at the previous scan boundary;
  // email_source's tenant/account/message unique key removes duplicates.
  const fromDate = resolvePhase1aScanStart(
    lastSuccessful?.createdAt ?? null,
    input.period ?? "6m",
    now,
  );
  if (!lastSuccessful && input.period) {
    await prisma.user.update({
      where: { id: input.userId },
      data: { syncFromDate: fromDate },
    });
  }
  const effectiveGmailQuery = `after:${Math.floor(fromDate.getTime() / 1000)} ${filter.gmailQuery}`;
  const message: ScanWorkerMessage = {
    scanRunId: "",
    stage: "DISCOVERY",
    sequence: "0",
  };

  const scan = await prisma.emailScanRun.create({
    data: {
      userId: input.userId,
      clientRequestId,
      gmailAccountId: account.id,
      emailFilterId: filter.filterId,
      emailFilterVersionId: filter.versionId,
      effectiveGmailQuery,
      fromDate,
      toDate: now,
      status: "CREATED",
      currentStage: null,
      filterRuleSchemaVersion: filter.ruleSchemaVersion,
      filterEvaluatorVersion: filter.evaluatorVersion,
      filterSnapshotJson: {
        includeRules: filter.includeRules,
        excludeRules: filter.excludeRules,
      },
      pendingContinuationSequence: BigInt(0),
      pendingContinuationStage: "DISCOVERY",
      pendingContinuationNotBefore: now,
    },
  });
  message.scanRunId = scan.id;

  try {
    await scheduler.publish(message, {
      deduplicationId: workerDeduplicationId(message),
    });
    await prisma.emailScanRun.updateMany({
      where: {
        id: scan.id,
        pendingContinuationSequence: BigInt(0),
        pendingContinuationStage: "DISCOVERY",
      },
      data: { pendingContinuationPublishedAt: new Date() },
    });
    return {
      scanRunId: scan.id,
      clientRequestId,
      schedulingStatus: "SCHEDULED",
      idempotentReplay: false,
    };
  } catch {
    return {
      scanRunId: scan.id,
      clientRequestId,
      schedulingStatus: "PENDING_RETRY",
      idempotentReplay: false,
    };
  }
}
