import { prisma } from "@/lib/prisma";
import {
  calculateScanProgress,
  type ReconciledScanCounters,
} from "@/lib/scan/progress";
import { isScanRunStatus } from "@/lib/scan/types";

type ScanRunRecord = {
  id: string;
  status: string;
  discoveryComplete: boolean;
  totalDiscovered: number;
  fetchPendingCount: number;
  fetchInProgressCount: number;
  fetchSuccessCount: number;
  fetchFailedCount: number;
  filterIncludedCount: number;
  filterExcludedCount: number;
  manualReviewCount: number;
  startedAt: Date | null;
  lastCheckpointAt: Date | null;
  completedAt: Date | null;
  pausedAt: Date | null;
  cancelledAt: Date | null;
};

type ScanItemGroup = {
  status: string;
  filterDecision: string;
  _count: { _all: number };
};

export type ScanProgressStore = {
  emailScanRun: {
    findFirst(args: unknown): Promise<ScanRunRecord | null>;
  };
  emailScanItem: {
    groupBy(args: unknown): Promise<ScanItemGroup[]>;
  };
};

function countGroups(
  groups: ScanItemGroup[],
  predicate: (group: ScanItemGroup) => boolean,
): number {
  return groups
    .filter(predicate)
    .reduce((total, group) => total + group._count._all, 0);
}

export async function getScanProgressForUser(
  userId: string,
  scanRunId: string,
  store: ScanProgressStore = prisma as unknown as ScanProgressStore,
) {
  const scan = await store.emailScanRun.findFirst({
    where: { id: scanRunId, userId },
    select: {
      id: true,
      status: true,
      discoveryComplete: true,
      totalDiscovered: true,
      fetchPendingCount: true,
      fetchInProgressCount: true,
      fetchSuccessCount: true,
      fetchFailedCount: true,
      filterIncludedCount: true,
      filterExcludedCount: true,
      manualReviewCount: true,
      startedAt: true,
      lastCheckpointAt: true,
      completedAt: true,
      pausedAt: true,
      cancelledAt: true,
    },
  });

  if (!scan) return null;
  if (!isScanRunStatus(scan.status)) {
    throw new Error("Invalid persisted scan status");
  }

  const groups = await store.emailScanItem.groupBy({
    by: ["status", "filterDecision"],
    where: { scanRunId },
    _count: { _all: true },
  });

  const cancelledCount = countGroups(groups, (group) => group.status === "CANCELLED");
  const totalItemCount = countGroups(groups, () => true);
  const fetchedCount = countGroups(groups, (group) => group.status === "FETCHED");
  const counters: ReconciledScanCounters = {
    totalDiscovered: totalItemCount - cancelledCount,
    discoveredCount: countGroups(groups, (group) => group.status === "DISCOVERED"),
    fetchingCount: countGroups(groups, (group) => group.status === "FETCHING"),
    retryWaitCount: countGroups(groups, (group) => group.status === "RETRY_WAIT"),
    permanentlyFailedCount: countGroups(
      groups,
      (group) => group.status === "PERMANENTLY_FAILED",
    ),
    fetchedIncludedCount: countGroups(
      groups,
      (group) => group.status === "FETCHED" && group.filterDecision === "INCLUDED",
    ),
    fetchedExcludedCount: countGroups(
      groups,
      (group) => group.status === "FETCHED" && group.filterDecision === "EXCLUDED",
    ),
    fetchedPendingCount: countGroups(
      groups,
      (group) => group.status === "FETCHED" && group.filterDecision === "PENDING",
    ),
    cancelledCount,
  };

  const cacheMatches =
    scan.totalDiscovered === counters.totalDiscovered &&
    scan.fetchPendingCount === counters.discoveredCount &&
    scan.fetchInProgressCount === counters.fetchingCount &&
    scan.fetchSuccessCount === fetchedCount &&
    scan.fetchFailedCount === counters.permanentlyFailedCount &&
    scan.filterIncludedCount === counters.fetchedIncludedCount &&
    scan.filterExcludedCount === counters.fetchedExcludedCount;

  return {
    scanRunId: scan.id,
    status: scan.status,
    discoveryComplete: scan.discoveryComplete,
    counters,
    progress: calculateScanProgress(scan.status, scan.discoveryComplete, counters),
    cacheMatches,
    manualReviewCount: scan.manualReviewCount,
    startedAt: scan.startedAt,
    lastCheckpointAt: scan.lastCheckpointAt,
    completedAt: scan.completedAt,
    pausedAt: scan.pausedAt,
    cancelledAt: scan.cancelledAt,
  };
}
