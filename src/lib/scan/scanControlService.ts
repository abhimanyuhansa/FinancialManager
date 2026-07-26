import { prisma } from "@/lib/prisma";
import {
  type SchedulerService,
  type ScanWorkerMessage,
  workerDeduplicationId,
} from "@/lib/scan/scheduler";

async function ownedScan(userId: string, scanRunId: string) {
  return prisma.emailScanRun.findFirst({
    where: { id: scanRunId, userId },
  });
}

async function publishPending(
  scheduler: SchedulerService,
  message: ScanWorkerMessage,
  notBefore?: Date | null,
) {
  await scheduler.publish(message, {
    deduplicationId: workerDeduplicationId(message),
    notBefore,
  });
  await prisma.emailScanRun.updateMany({
    where: {
      id: message.scanRunId,
      pendingContinuationSequence: BigInt(message.sequence),
      pendingContinuationStage: message.stage,
    },
    data: { pendingContinuationPublishedAt: new Date() },
  });
}

export async function pauseScan(userId: string, scanRunId: string) {
  const scan = await ownedScan(userId, scanRunId);
  if (!scan) return null;
  if (!["CREATED", "DISCOVERING", "FETCHING", "RETRY_WAIT"].includes(scan.status)) {
    return { status: scan.status, changed: false };
  }
  const updated = await prisma.emailScanRun.updateMany({
    where: {
      id: scanRunId,
      userId,
      status: { in: ["CREATED", "DISCOVERING", "FETCHING", "RETRY_WAIT"] },
    },
    data: {
      status: "PAUSED",
      resumeStage: scan.currentStage ?? scan.pendingContinuationStage ?? "DISCOVERY",
      currentStage: null,
      startedAt: scan.startedAt ?? new Date(),
      pausedAt: new Date(),
      stateVersion: { increment: 1 },
    },
  });
  return { status: "PAUSED", changed: updated.count === 1 };
}

export async function resumeScan(
  userId: string,
  scanRunId: string,
  scheduler: SchedulerService,
) {
  const scan = await ownedScan(userId, scanRunId);
  if (!scan) return null;
  if (scan.status !== "PAUSED") return { status: scan.status, changed: false };

  const stage = (scan.resumeStage ?? "DISCOVERY") as "DISCOVERY" | "FETCH";
  const sequence = scan.batchSequence + BigInt(1);
  const message: ScanWorkerMessage = {
    scanRunId,
    stage,
    sequence: sequence.toString(),
  };
  await prisma.emailScanRun.update({
    where: { id: scanRunId },
    data: {
      status: stage === "DISCOVERY" ? "DISCOVERING" : "FETCHING",
      currentStage: stage,
      resumeStage: null,
      pausedAt: null,
      nextRetryAt: null,
      batchSequence: sequence,
      pendingContinuationSequence: sequence,
      pendingContinuationStage: stage,
      pendingContinuationNotBefore: new Date(),
      pendingContinuationPublishedAt: null,
      stateVersion: { increment: 1 },
    },
  });
  await publishPending(scheduler, message);
  return { status: stage === "DISCOVERY" ? "DISCOVERING" : "FETCHING", changed: true };
}

export async function cancelScan(userId: string, scanRunId: string) {
  const scan = await ownedScan(userId, scanRunId);
  if (!scan) return null;
  if (scan.status === "CANCELLED") return { status: "CANCELLED", changed: false };
  if (["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"].includes(scan.status)) {
    return { status: scan.status, changed: false };
  }

  const leaseActive =
    !!scan.workerLeaseOwner &&
    !!scan.workerLeaseExpiresAt &&
    scan.workerLeaseExpiresAt > new Date();
  if (leaseActive) {
    await prisma.emailScanRun.update({
      where: { id: scanRunId },
      data: { status: "CANCELLING", stateVersion: { increment: 1 } },
    });
    return { status: "CANCELLING", changed: true };
  }

  await prisma.$transaction([
    prisma.emailScanItem.updateMany({
      where: {
        scanRunId,
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
      where: { id: scanRunId },
      data: {
        status: "CANCELLED",
        currentStage: null,
        resumeStage: null,
        cancelledAt: new Date(),
        workerLeaseOwner: null,
        workerLeaseExpiresAt: null,
        nextRetryAt: null,
        pendingContinuationSequence: null,
        pendingContinuationStage: null,
        pendingContinuationNotBefore: null,
        pendingContinuationPublishedAt: null,
        stateVersion: { increment: 1 },
      },
    }),
  ]);
  return { status: "CANCELLED", changed: true };
}

export async function retryScan(
  userId: string,
  scanRunId: string,
  scheduler: SchedulerService,
) {
  const scan = await ownedScan(userId, scanRunId);
  if (!scan) return null;
  if (!["CREATED", "DISCOVERING", "FETCHING", "RETRY_WAIT"].includes(scan.status)) {
    return { status: scan.status, changed: false };
  }
  if (
    scan.workerLeaseOwner &&
    scan.workerLeaseExpiresAt &&
    scan.workerLeaseExpiresAt > new Date()
  ) {
    return { status: scan.status, changed: false };
  }

  const stage = (scan.currentStage ?? scan.pendingContinuationStage ?? "DISCOVERY") as
    | "DISCOVERY"
    | "FETCH";
  const reusePending =
    scan.pendingContinuationSequence !== null &&
    scan.pendingContinuationPublishedAt === null;
  const sequence = reusePending
    ? scan.pendingContinuationSequence!
    : scan.batchSequence + BigInt(1);
  const message: ScanWorkerMessage = {
    scanRunId,
    stage,
    sequence: sequence.toString(),
  };
  await prisma.emailScanRun.update({
    where: { id: scanRunId },
    data: {
      status: stage === "DISCOVERY" ? "DISCOVERING" : "FETCHING",
      currentStage: stage,
      resumeStage: null,
      startedAt: scan.startedAt ?? new Date(),
      nextRetryAt: null,
      batchSequence: reusePending ? scan.batchSequence : sequence,
      pendingContinuationSequence: sequence,
      pendingContinuationStage: stage,
      pendingContinuationNotBefore: new Date(),
      pendingContinuationPublishedAt: null,
      stateVersion: { increment: 1 },
    },
  });
  await publishPending(scheduler, message);
  return { status: stage === "DISCOVERY" ? "DISCOVERING" : "FETCHING", changed: true };
}
