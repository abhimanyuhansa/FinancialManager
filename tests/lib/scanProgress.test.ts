import { calculateScanProgress } from "@/lib/scan/progress";

describe("Phase 1A scan progress", () => {
  it("counts excluded emails once as a fetched, evaluated result", () => {
    expect(
      calculateScanProgress("FETCHING", true, {
        totalDiscovered: 100,
        discoveredCount: 0,
        fetchingCount: 0,
        retryWaitCount: 0,
        permanentlyFailedCount: 2,
        fetchedIncludedCount: 78,
        fetchedExcludedCount: 20,
        fetchedPendingCount: 0,
        cancelledCount: 0,
      }),
    ).toEqual({
      processedCount: 100,
      remainingCount: 0,
      percentage: 100,
      canComplete: true,
    });
  });

  it("does not display 100% while a fetched item still needs evaluation", () => {
    expect(
      calculateScanProgress("FETCHING", true, {
        totalDiscovered: 2,
        discoveredCount: 0,
        fetchingCount: 0,
        retryWaitCount: 0,
        permanentlyFailedCount: 0,
        fetchedIncludedCount: 2,
        fetchedExcludedCount: 0,
        fetchedPendingCount: 1,
        cancelledCount: 0,
      }),
    ).toEqual({
      processedCount: 2,
      remainingCount: 0,
      percentage: 99.9,
      canComplete: false,
    });
  });

  it("uses a terminal cancelled display instead of a completion percentage", () => {
    expect(
      calculateScanProgress("CANCELLED", false, {
        totalDiscovered: 4,
        discoveredCount: 0,
        fetchingCount: 0,
        retryWaitCount: 0,
        permanentlyFailedCount: 0,
        fetchedIncludedCount: 3,
        fetchedExcludedCount: 0,
        fetchedPendingCount: 0,
        cancelledCount: 1,
      }),
    ).toEqual({
      processedCount: 3,
      remainingCount: 1,
      percentage: null,
      canComplete: false,
    });
  });
});
