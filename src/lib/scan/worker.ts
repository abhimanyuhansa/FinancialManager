import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  fetchFullMessageBatch,
  fetchMessageIdPage,
  getGmailToken,
} from "@/lib/gmail";
import {
  evaluateFilter,
  SUPPORTED_FILTER_EVALUATOR_VERSION,
  SUPPORTED_RULE_SCHEMA_VERSION,
  validateFilterRules,
} from "@/lib/scan/filterEvaluator";
import {
  type SchedulerService,
  type ScanWorkerMessage,
  workerDeduplicationId,
} from "@/lib/scan/scheduler";
import { sanitizeErrorMessage } from "@/lib/scan/sanitize";

const TERMINAL = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
]);
const ACTIVE = ["CREATED", "DISCOVERING", "FETCHING", "RETRY_WAIT"];
const FETCH_BATCH_SIZE = 25;

function leaseDurationMs(): number {
  const seconds = Number(process.env.WORKER_LEASE_DURATION_SECONDS ?? "55");
  return (Number.isFinite(seconds) && seconds > 5 ? seconds : 55) * 1000;
}

function retryDelayMs(): number {
  const seconds = Number(process.env.WORKER_RETRY_DELAY_SECONDS ?? "120");
  return (Number.isFinite(seconds) && seconds >= 1 ? seconds : 120) * 1000;
}

async function acknowledgePublication(message: ScanWorkerMessage) {
  await prisma.emailScanRun.updateMany({
    where: {
      id: message.scanRunId,
      pendingContinuationSequence: BigInt(message.sequence),
      pendingContinuationStage: message.stage,
    },
    data: { pendingContinuationPublishedAt: new Date() },
  });
}

async function publishContinuation(
  scheduler: SchedulerService,
  message: ScanWorkerMessage,
  notBefore?: Date | null,
) {
  await scheduler.publish(message, {
    deduplicationId: workerDeduplicationId(message),
    notBefore,
  });
  await acknowledgePublication(message);
}

async function deferScanRetry(
  scan: {
    id: string;
    retryCount: number;
    maxRetries: number;
    batchSequence: bigint;
  },
  leaseOwner: string,
  stage: "DISCOVERY" | "FETCH",
  scheduler: SchedulerService,
  error: unknown,
) {
  if (scan.retryCount >= scan.maxRetries) {
    await failScan(
      scan.id,
      leaseOwner,
      "GMAIL_SCAN_RETRIES_EXHAUSTED",
      "Gmail scan retry limit was reached",
    );
    return { outcome: "failed_retries" as const };
  }
  const sequence = scan.batchSequence + BigInt(1);
  const notBefore = new Date(Date.now() + retryDelayMs());
  const message: ScanWorkerMessage = {
    scanRunId: scan.id,
    stage,
    sequence: sequence.toString(),
  };
  const updated = await prisma.emailScanRun.updateMany({
    where: { id: scan.id, workerLeaseOwner: leaseOwner },
    data: {
      status: "RETRY_WAIT",
      currentStage: null,
      resumeStage: stage,
      nextRetryAt: notBefore,
      retryCount: { increment: 1 },
      lastErrorCode: "GMAIL_SCAN_RETRYABLE",
      lastErrorMessageSanitized: sanitizeErrorMessage(error),
      batchSequence: sequence,
      pendingContinuationSequence: sequence,
      pendingContinuationStage: stage,
      pendingContinuationNotBefore: notBefore,
      pendingContinuationPublishedAt: null,
      workerLeaseOwner: null,
      workerLeaseExpiresAt: null,
      stateVersion: { increment: 1 },
    },
  });
  if (updated.count !== 1) return { outcome: "lease_lost" as const };
  try {
    await publishContinuation(scheduler, message, notBefore);
  } catch {
    // The durable pending continuation is recoverable through the retry control.
  }
  return { outcome: "retry_wait" as const };
}

async function failScan(
  scanRunId: string,
  leaseOwner: string,
  code: string,
  message: string,
) {
  await prisma.emailScanRun.updateMany({
    where: { id: scanRunId, workerLeaseOwner: leaseOwner },
    data: {
      status: "FAILED",
      currentStage: null,
      resumeStage: null,
      nextRetryAt: null,
      lastErrorCode: code,
      lastErrorMessageSanitized: message,
      pendingContinuationSequence: null,
      pendingContinuationStage: null,
      pendingContinuationNotBefore: null,
      pendingContinuationPublishedAt: null,
      workerLeaseOwner: null,
      workerLeaseExpiresAt: null,
    },
  });
}

async function reconcileAndCheckpoint(
  scanRunId: string,
  leaseOwner: string,
  nextStage: "DISCOVERY" | "FETCH",
  discoveryComplete: boolean,
) {
  return prisma.$transaction(async (tx) => {
    const groups = await tx.emailScanItem.groupBy({
      by: ["status", "filterDecision"],
      where: { scanRunId },
      _count: { _all: true },
    });
    const count = (status: string, decision?: string) =>
      groups
        .filter(
          (group) =>
            group.status === status &&
            (decision === undefined || group.filterDecision === decision),
        )
        .reduce((total, group) => total + group._count._all, 0);

    const discovered = count("DISCOVERED");
    const fetching = count("FETCHING");
    const retryWait = count("RETRY_WAIT");
    const fetched = count("FETCHED");
    const failed = count("PERMANENTLY_FAILED");
    const cancelled = count("CANCELLED");
    const included = count("FETCHED", "INCLUDED");
    const excluded = count("FETCHED", "EXCLUDED");
    const fetchedPending = count("FETCHED", "PENDING");
    const total = groups.reduce((sum, group) => sum + group._count._all, 0) - cancelled;
    const complete =
      discoveryComplete &&
      discovered === 0 &&
      fetching === 0 &&
      retryWait === 0 &&
      fetchedPending === 0 &&
      cancelled === 0 &&
      included + excluded + failed === total;
    const nextSequence = await tx.emailScanRun.findUniqueOrThrow({
      where: { id: scanRunId },
      select: { batchSequence: true },
    });
    const nextItemRetry = await tx.emailScanItem.aggregate({
      where: { scanRunId, status: "RETRY_WAIT" },
      _min: { nextRetryAt: true },
    });
    const sequence = nextSequence.batchSequence + BigInt(1);
    const terminalStatus = failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    const waitingForRetry =
      !complete && discovered === 0 && fetching === 0 && retryWait > 0;
    const continuationNotBefore =
      waitingForRetry && nextItemRetry._min.nextRetryAt
        ? nextItemRetry._min.nextRetryAt
        : new Date();

    const updated = await tx.emailScanRun.updateMany({
      where: { id: scanRunId, workerLeaseOwner: leaseOwner },
      data: {
        status: complete
          ? terminalStatus
          : waitingForRetry
            ? "RETRY_WAIT"
            : nextStage === "DISCOVERY"
              ? "DISCOVERING"
              : "FETCHING",
        currentStage: complete || waitingForRetry ? null : nextStage,
        resumeStage: waitingForRetry ? nextStage : null,
        batchSequence: sequence,
        totalDiscovered: total,
        fetchPendingCount: discovered,
        fetchInProgressCount: fetching,
        fetchSuccessCount: fetched,
        fetchFailedCount: failed,
        filterIncludedCount: included,
        filterExcludedCount: excluded,
        manualReviewCount: included,
        lastCheckpointAt: new Date(),
        lastBatchCompletedAt: new Date(),
        completedAt: complete ? new Date() : null,
        workerLeaseOwner: null,
        workerLeaseExpiresAt: null,
        pendingContinuationSequence: complete ? null : sequence,
        pendingContinuationStage: complete ? null : nextStage,
        nextRetryAt: waitingForRetry ? continuationNotBefore : null,
        pendingContinuationNotBefore: complete ? null : continuationNotBefore,
        pendingContinuationPublishedAt: null,
      },
    });
    if (updated.count !== 1) throw new Error("Scan lease lost before checkpoint");

    return complete
      ? { complete: true as const, next: null }
      : {
          complete: false as const,
          next: {
            message: {
              scanRunId,
              stage: nextStage,
              sequence: sequence.toString(),
            } satisfies ScanWorkerMessage,
            notBefore: continuationNotBefore,
          },
        };
  });
}

async function processDiscovery(
  scan: {
    id: string;
    userId: string;
    gmailAccountId: string;
    effectiveGmailQuery: string;
    discoveryPageToken: string | null;
  },
  accessToken: string,
  leaseOwner: string,
) {
  const page = await fetchMessageIdPage(
    accessToken,
    scan.effectiveGmailQuery,
    scan.discoveryPageToken ?? undefined,
  );
  await prisma.$transaction(async (tx) => {
    await tx.emailSource.createMany({
      data: page.messageIds.map((gmailMessageId) => ({
        userId: scan.userId,
        gmailAccountId: scan.gmailAccountId,
        gmailMessageId,
        gmailLabels: [],
        sourceUrl: `https://mail.google.com/mail/u/0/#all/${gmailMessageId}`,
      })),
      skipDuplicates: true,
    });
    const sources = await tx.emailSource.findMany({
      where: {
        userId: scan.userId,
        gmailAccountId: scan.gmailAccountId,
        gmailMessageId: { in: page.messageIds },
      },
      select: { id: true },
    });
    await tx.emailScanItem.createMany({
      data: sources.map((source) => ({
        scanRunId: scan.id,
        emailSourceId: source.id,
        matchedIncludeRuleIds: [],
        matchedExcludeRuleIds: [],
      })),
      skipDuplicates: true,
    });
    await tx.emailScanRun.updateMany({
      where: { id: scan.id, workerLeaseOwner: leaseOwner },
      data: {
        discoveryPageToken: page.nextPageToken ?? null,
        discoveryComplete: !page.nextPageToken,
      },
    });
  });
  return !page.nextPageToken;
}

async function processFetch(
  scan: {
    id: string;
    filterSnapshotJson: unknown;
    maxItemRetries: number;
  },
  accessToken: string,
) {
  const itemLeaseOwner = randomUUID();
  const candidates = await prisma.emailScanItem.findMany({
    where: {
      scanRunId: scan.id,
      OR: [
        { status: "DISCOVERED" },
        {
          status: "RETRY_WAIT",
          nextRetryAt: { lte: new Date() },
          fetchAttemptCount: { lt: scan.maxItemRetries },
        },
      ],
    },
    orderBy: { discoveredAt: "asc" },
    take: FETCH_BATCH_SIZE,
    include: { emailSource: { select: { id: true, gmailMessageId: true } } },
  });
  if (candidates.length === 0) return;

  await prisma.emailScanItem.updateMany({
    where: { id: { in: candidates.map((item) => item.id) }, status: { in: ["DISCOVERED", "RETRY_WAIT"] } },
    data: {
      status: "FETCHING",
      itemLeaseOwner,
      itemLeaseExpiresAt: new Date(Date.now() + leaseDurationMs()),
      fetchStartedAt: new Date(),
      fetchAttemptCount: { increment: 1 },
    },
  });
  await prisma.emailSource.updateMany({
    where: { id: { in: candidates.map((item) => item.emailSource.id) } },
    data: {
      lastFetchStatus: "FETCHING",
      lastFetchAttemptAt: new Date(),
      lastFetchErrorCode: null,
      lastFetchErrorMessageSanitized: null,
    },
  });

  const snapshotValue = scan.filterSnapshotJson as {
    includeRules?: unknown;
    excludeRules?: unknown;
  };
  const snapshot = validateFilterRules(
    snapshotValue.includeRules ?? [],
    snapshotValue.excludeRules ?? [],
  );

  try {
    const messages = await fetchFullMessageBatch(
      accessToken,
      candidates.map((item) => item.emailSource.gmailMessageId),
      { metadataOnly: true },
    );
    const byId = new Map(messages.map((message) => [message.id, message]));

    await prisma.$transaction(async (tx) => {
      for (const item of candidates) {
        const message = byId.get(item.emailSource.gmailMessageId);
        if (!message) {
          await tx.emailSource.update({
            where: { id: item.emailSource.id },
            data: {
              lastFetchStatus: "PERMANENTLY_FAILED",
              lastFetchAttemptAt: new Date(),
              lastFetchErrorCode: "GMAIL_MESSAGE_MISSING",
              lastFetchErrorMessageSanitized:
                "Gmail message could not be fetched",
            },
          });
          await tx.emailScanItem.updateMany({
            where: { id: item.id, itemLeaseOwner },
            data: {
              status: "PERMANENTLY_FAILED",
              lastErrorCode: "GMAIL_MESSAGE_MISSING",
              lastErrorMessageSanitized: "Gmail message could not be fetched",
              itemLeaseOwner: null,
              itemLeaseExpiresAt: null,
              fetchCompletedAt: new Date(),
              stateVersion: { increment: 1 },
            },
          });
          continue;
        }
        const result = evaluateFilter(snapshot, {
          senderDomain: message.senderDomain,
          senderEmail: message.senderEmail,
          subject: message.subject,
        });
        await tx.emailSource.update({
          where: { id: item.emailSource.id },
          data: {
            subject: message.subject,
            normalizedSubject: message.subject.toLowerCase().replace(/\s+/g, " ").trim(),
            senderEmail: message.senderEmail,
            senderName: message.senderName,
            senderDomain: message.senderDomain,
            receivedAt: new Date(message.receivedDate),
            gmailThreadId: message.gmailThreadId,
            gmailLabels: message.gmailLabels,
            hasAttachment: message.hasPdfAttachment,
            attachmentMetadata: message.hasPdfAttachment
              ? [{ contentType: "application/pdf" }]
              : [],
            lastFetchStatus: "FETCHED",
            lastFetchAttemptAt: new Date(),
            lastFetchedAt: new Date(),
            lastFetchErrorCode: null,
            lastFetchErrorMessageSanitized: null,
          },
        });
        await tx.emailScanItem.updateMany({
          where: { id: item.id, itemLeaseOwner },
          data: {
            status: "FETCHED",
            filterDecision: result.decision,
            matchedIncludeRuleIds: result.matchedIncludeRuleIds,
            matchedExcludeRuleIds: result.matchedExcludeRuleIds,
            filterDecisionReasonSanitized:
              result.decision === "EXCLUDED" ? "Matched exclusion policy" : "Included by filter policy",
            itemLeaseOwner: null,
            itemLeaseExpiresAt: null,
            nextRetryAt: null,
            fetchCompletedAt: new Date(),
            stateVersion: { increment: 1 },
          },
        });
      }
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("401") || error.message.includes("403"))
    ) {
      throw error;
    }
    const retryable =
      error instanceof Error &&
      (error.message.includes("GMAIL_RATE_LIMITED") ||
        error.message.includes("429") ||
        error.message.includes("503"));
    const nextRetryAt = new Date(Date.now() + retryDelayMs());
    await prisma.emailScanItem.updateMany({
      where: {
        id: { in: candidates.map((item) => item.id) },
        itemLeaseOwner,
      },
      data: retryable
        ? {
            status: "RETRY_WAIT",
            nextRetryAt,
            lastErrorCode: "GMAIL_RETRYABLE",
            lastErrorMessageSanitized: sanitizeErrorMessage(error),
            itemLeaseOwner: null,
            itemLeaseExpiresAt: null,
            stateVersion: { increment: 1 },
          }
        : {
            status: "PERMANENTLY_FAILED",
            lastErrorCode: "GMAIL_FETCH_FAILED",
            lastErrorMessageSanitized: sanitizeErrorMessage(error),
            itemLeaseOwner: null,
            itemLeaseExpiresAt: null,
            fetchCompletedAt: new Date(),
            stateVersion: { increment: 1 },
          },
    });
    await prisma.emailSource.updateMany({
      where: { id: { in: candidates.map((item) => item.emailSource.id) } },
      data: retryable
        ? {
            lastFetchStatus: "DISCOVERED",
            lastFetchErrorCode: "GMAIL_RETRYABLE",
            lastFetchErrorMessageSanitized: sanitizeErrorMessage(error),
          }
        : {
            lastFetchStatus: "PERMANENTLY_FAILED",
            lastFetchErrorCode: "GMAIL_FETCH_FAILED",
            lastFetchErrorMessageSanitized: sanitizeErrorMessage(error),
          },
    });
  }
}

export async function processScanWorkerMessage(
  message: ScanWorkerMessage,
  scheduler: SchedulerService,
) {
  const sequence = BigInt(message.sequence);
  const beforeLease = await prisma.emailScanRun.findUnique({
    where: { id: message.scanRunId },
  });
  if (!beforeLease || TERMINAL.has(beforeLease.status) || beforeLease.status === "PAUSED") {
    return { outcome: "noop" as const };
  }
  if (beforeLease.status === "CANCELLING") {
    await prisma.$transaction([
      prisma.emailScanItem.updateMany({
        where: {
          scanRunId: beforeLease.id,
          status: { in: ["DISCOVERED", "FETCHING", "RETRY_WAIT"] },
        },
        data: {
          status: "CANCELLED",
          itemLeaseOwner: null,
          itemLeaseExpiresAt: null,
          nextRetryAt: null,
          stateVersion: { increment: 1 },
        },
      }),
      prisma.emailScanRun.update({
        where: { id: beforeLease.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          currentStage: null,
          resumeStage: null,
          workerLeaseOwner: null,
          workerLeaseExpiresAt: null,
          nextRetryAt: null,
          pendingContinuationSequence: null,
          pendingContinuationStage: null,
          pendingContinuationNotBefore: null,
          pendingContinuationPublishedAt: null,
        },
      }),
    ]);
    return { outcome: "cancelled" as const };
  }
  if (
    beforeLease.pendingContinuationSequence !== sequence ||
    beforeLease.pendingContinuationStage !== message.stage
  ) {
    return { outcome: "invalid_sequence" as const };
  }

  const leaseOwner = randomUUID();
  const leased = await prisma.emailScanRun.updateMany({
    where: {
      id: message.scanRunId,
      status: { in: ACTIVE },
      pendingContinuationSequence: sequence,
      pendingContinuationStage: message.stage,
      OR: [
        { workerLeaseOwner: null },
        { workerLeaseExpiresAt: { lt: new Date() } },
      ],
    },
    data: {
      status: message.stage === "DISCOVERY" ? "DISCOVERING" : "FETCHING",
      currentStage: message.stage,
      resumeStage: null,
      nextRetryAt: null,
      startedAt: beforeLease.startedAt ?? new Date(),
      lastBatchStartedAt: new Date(),
      workerLeaseOwner: leaseOwner,
      workerLeaseExpiresAt: new Date(Date.now() + leaseDurationMs()),
      stateVersion: { increment: 1 },
    },
  });
  if (leased.count !== 1) return { outcome: "lease_busy" as const };

  const scan = await prisma.emailScanRun.findUniqueOrThrow({
    where: { id: message.scanRunId },
  });
  if (
    scan.filterRuleSchemaVersion !== SUPPORTED_RULE_SCHEMA_VERSION ||
    scan.filterEvaluatorVersion !== SUPPORTED_FILTER_EVALUATOR_VERSION
  ) {
    await failScan(
      scan.id,
      leaseOwner,
      "INCOMPATIBLE_FILTER_VERSION",
      "Stored filter version is incompatible",
    );
    return { outcome: "failed_filter" as const };
  }
  try {
    const snapshot = scan.filterSnapshotJson as {
      includeRules?: unknown;
      excludeRules?: unknown;
    };
    validateFilterRules(snapshot.includeRules ?? [], snapshot.excludeRules ?? []);
  } catch {
    await failScan(
      scan.id,
      leaseOwner,
      "INVALID_FILTER_SCHEMA",
      "Stored filter rules are invalid",
    );
    return { outcome: "failed_filter" as const };
  }

  let nextStage: "DISCOVERY" | "FETCH" = message.stage;
  try {
    const accessToken = await getGmailToken(scan.userId);
    if (!accessToken) {
      await failScan(
        scan.id,
        leaseOwner,
        "GMAIL_AUTH_REQUIRED",
        "Gmail authorization is required",
      );
      return { outcome: "failed_auth" as const };
    }

    if (message.stage === "DISCOVERY") {
      const discoveryComplete = await processDiscovery(
        scan,
        accessToken,
        leaseOwner,
      );
      nextStage = discoveryComplete ? "FETCH" : "DISCOVERY";
    } else {
      await processFetch(scan, accessToken);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("401") || error.message.includes("403"))
    ) {
      await failScan(
        scan.id,
        leaseOwner,
        "GMAIL_AUTH_REQUIRED",
        "Gmail authorization does not permit message access",
      );
      return { outcome: "failed_auth" as const };
    }
    return deferScanRetry(scan, leaseOwner, message.stage, scheduler, error);
  }

  const current = await prisma.emailScanRun.findUniqueOrThrow({
    where: { id: scan.id },
    select: { discoveryComplete: true },
  });
  const checkpoint = await reconcileAndCheckpoint(
    scan.id,
    leaseOwner,
    nextStage,
    current.discoveryComplete,
  );
  if (checkpoint.next) {
    await publishContinuation(
      scheduler,
      checkpoint.next.message,
      checkpoint.next.notBefore,
    );
  }
  return { outcome: checkpoint.complete ? "complete" : "continued" };
}
