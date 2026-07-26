import { prisma } from "@/lib/prisma";
import { fetchMessageIdPage, getGmailToken } from "@/lib/gmail";
import { classifyEmail } from "@/lib/scan/classificationService";
import { cancelScan, pauseScan, resumeScan } from "@/lib/scan/scanControlService";
import { createScan } from "@/lib/scan/scanDomainService";
import type {
  ScheduleOptions,
  SchedulerService,
  ScanWorkerMessage,
} from "@/lib/scan/scheduler";
import { processScanWorkerMessage } from "@/lib/scan/worker";

const enabled = process.env.PHASE1A_REAL_SMOKE === "true";
const describeReal = enabled ? describe : describe.skip;

class QueueScheduler implements SchedulerService {
  readonly queue: Array<{
    message: ScanWorkerMessage;
    options: ScheduleOptions;
  }> = [];

  async publish(message: ScanWorkerMessage, options: ScheduleOptions) {
    this.queue.push({ message, options });
  }
}

async function drainQueue(scheduler: QueueScheduler) {
  let iterations = 0;
  const outcomes: Record<string, number> = {};
  while (scheduler.queue.length > 0 && iterations < 1_000) {
    const job = scheduler.queue.shift()!;
    const waitMs = Math.max(
      0,
      (job.options.notBefore?.getTime() ?? Date.now()) - Date.now(),
    );
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const result = await processScanWorkerMessage(job.message, scheduler);
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
    iterations += 1;
  }
  if (scheduler.queue.length > 0) {
    throw new Error("Phase 1A smoke exceeded its bounded worker iteration limit");
  }
  return { iterations, outcomes };
}

describeReal("Phase 1A real Neon branch and Gmail smoke", () => {
  jest.setTimeout(15 * 60 * 1_000);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("runs a six-month scan, controls it, deduplicates inventory, and avoids ingestion", async () => {
    process.env.WORKER_RETRY_DELAY_SECONDS = "1";
    const accounts = await prisma.account.findMany({
      where: {
        provider: "google",
        disconnectedAt: null,
        OR: [{ access_token: { not: null } }, { refresh_token: { not: null } }],
      },
      select: { userId: true },
    });
    let account: (typeof accounts)[number] | null = null;
    for (const candidate of accounts) {
      const token = await getGmailToken(candidate.userId);
      if (!token) continue;
      try {
        await fetchMessageIdPage(token, "newer_than:1d");
        account = candidate;
        break;
      } catch {
        // Try the next copied account without exposing account or token values.
      }
    }
    if (!account) {
      throw new Error("No usable Gmail authorization on the test branch");
    }

    const before = {
      sources: await prisma.emailSource.count({ where: { userId: account.userId } }),
      transactions: await prisma.transaction.count({
        where: { userId: account.userId },
      }),
      llmCalls: await prisma.llmCallLog.count(),
    };

    const firstScheduler = new QueueScheduler();
    const first = await createScan(
      {
        userId: account.userId,
        clientRequestId: `phase1a-smoke-first-${Date.now()}`,
        period: "6m",
      },
      firstScheduler,
    );
    expect(firstScheduler.queue).toHaveLength(1);
    expect(await pauseScan(account.userId, first.scanRunId)).toEqual({
      status: "PAUSED",
      changed: true,
    });
    const pausedDelivery = firstScheduler.queue.shift()!;
    await expect(
      processScanWorkerMessage(pausedDelivery.message, firstScheduler),
    ).resolves.toEqual({ outcome: "noop" });
    expect(
      await resumeScan(account.userId, first.scanRunId, firstScheduler),
    ).toEqual({ status: "DISCOVERING", changed: true });

    const firstWorker = await drainQueue(firstScheduler);
    const firstRun = await prisma.emailScanRun.findUniqueOrThrow({
      where: { id: first.scanRunId },
      select: {
        status: true,
        totalDiscovered: true,
        fetchSuccessCount: true,
        fetchFailedCount: true,
        filterIncludedCount: true,
        filterExcludedCount: true,
      },
    });
    expect(["COMPLETED", "COMPLETED_WITH_ERRORS"]).toContain(firstRun.status);

    const afterFirstSources = await prisma.emailSource.count({
      where: { userId: account.userId },
    });
    const reviewSource = await prisma.emailSource.findFirst({
      where: { userId: account.userId, deletedAt: null },
      orderBy: { firstDiscoveredAt: "desc" },
      select: { id: true },
    });
    if (!reviewSource) throw new Error("Scan did not produce reviewable metadata");
    const classification = await classifyEmail({
      userId: account.userId,
      sourceId: reviewSource.id,
      classification: "UNCERTAIN",
      reason: "Phase 1A branch smoke",
    });
    expect(["changed", "unchanged"]).toContain(classification.outcome);

    const secondScheduler = new QueueScheduler();
    const second = await createScan(
      {
        userId: account.userId,
        clientRequestId: `phase1a-smoke-incremental-${Date.now()}`,
        period: "6m",
      },
      secondScheduler,
    );
    const secondWorker = await drainQueue(secondScheduler);
    const secondRun = await prisma.emailScanRun.findUniqueOrThrow({
      where: { id: second.scanRunId },
      select: {
        status: true,
        totalDiscovered: true,
        fromDate: true,
        createdAt: true,
      },
    });
    expect(["COMPLETED", "COMPLETED_WITH_ERRORS"]).toContain(secondRun.status);

    const cancellationScheduler = new QueueScheduler();
    const cancellation = await createScan(
      {
        userId: account.userId,
        clientRequestId: `phase1a-smoke-cancel-${Date.now()}`,
      },
      cancellationScheduler,
    );
    expect(await cancelScan(account.userId, cancellation.scanRunId)).toEqual({
      status: "CANCELLED",
      changed: true,
    });

    const after = {
      sources: await prisma.emailSource.count({ where: { userId: account.userId } }),
      transactions: await prisma.transaction.count({
        where: { userId: account.userId },
      }),
      llmCalls: await prisma.llmCallLog.count(),
      classifications: await prisma.emailManualClassification.count({
        where: { userId: account.userId },
      }),
    };

    expect(after.transactions).toBe(before.transactions);
    expect(after.llmCalls).toBe(before.llmCalls);
    expect(after.sources).toBe(afterFirstSources);

    console.info(
      "PHASE1A_BRANCH_SMOKE",
      JSON.stringify({
        firstRun,
        firstWorker,
        secondRun: {
          status: secondRun.status,
          totalDiscovered: secondRun.totalDiscovered,
        },
        secondWorker,
        sourceCountBefore: before.sources,
        sourceCountAfterFirst: afterFirstSources,
        sourceCountAfterSecond: after.sources,
        sourceDuplicatesOnIncremental: after.sources - afterFirstSources,
        transactionCountChange: after.transactions - before.transactions,
        llmCallCountChange: after.llmCalls - before.llmCalls,
        classificationAuditCount: after.classifications,
      }),
    );
  });
});
