import type { ScanRunStatus } from "@/lib/scan/types";

export type ReconciledScanCounters = {
  totalDiscovered: number;
  discoveredCount: number;
  fetchingCount: number;
  retryWaitCount: number;
  permanentlyFailedCount: number;
  fetchedIncludedCount: number;
  fetchedExcludedCount: number;
  fetchedPendingCount: number;
  cancelledCount: number;
};

export type ScanProgress = {
  processedCount: number;
  remainingCount: number;
  percentage: number | null;
  canComplete: boolean;
};

const NON_NEGATIVE_INTEGER_FIELDS: Array<keyof ReconciledScanCounters> = [
  "totalDiscovered",
  "discoveredCount",
  "fetchingCount",
  "retryWaitCount",
  "permanentlyFailedCount",
  "fetchedIncludedCount",
  "fetchedExcludedCount",
  "fetchedPendingCount",
  "cancelledCount",
];

function assertValidCounters(counters: ReconciledScanCounters): void {
  for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
    const value = counters[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid scan counter: ${field}`);
    }
  }
}

export function calculateScanProgress(
  status: ScanRunStatus,
  discoveryComplete: boolean,
  counters: ReconciledScanCounters,
): ScanProgress {
  assertValidCounters(counters);

  // Included and excluded are disjoint subsets of FETCHED. Excluded must not
  // be added to a separate fetch-success total or it would be double-counted.
  const processedCount =
    counters.permanentlyFailedCount +
    counters.fetchedIncludedCount +
    counters.fetchedExcludedCount;
  const remainingCount = Math.max(0, counters.totalDiscovered - processedCount);
  const hasIncompleteItems =
    counters.discoveredCount > 0 ||
    counters.fetchingCount > 0 ||
    counters.retryWaitCount > 0 ||
    counters.fetchedPendingCount > 0;
  const canComplete =
    discoveryComplete &&
    !hasIncompleteItems &&
    counters.cancelledCount === 0 &&
    processedCount === counters.totalDiscovered;

  if (status === "CANCELLED") {
    return { processedCount, remainingCount, percentage: null, canComplete: false };
  }

  const rawPercentage =
    counters.totalDiscovered === 0
      ? canComplete
        ? 100
        : 0
      : (processedCount / counters.totalDiscovered) * 100;
  const percentage =
    !canComplete && rawPercentage >= 100
      ? 99.9
      : Math.round(Math.min(100, rawPercentage) * 10) / 10;

  return { processedCount, remainingCount, percentage, canComplete };
}
