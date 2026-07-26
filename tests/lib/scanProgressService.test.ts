import {
  getScanProgressForUser,
  type ScanProgressStore,
} from "@/lib/scan/scanProgressService";

const scan = {
  id: "scan-1",
  status: "FETCHING",
  discoveryComplete: true,
  totalDiscovered: 5,
  fetchPendingCount: 0,
  fetchInProgressCount: 0,
  fetchSuccessCount: 4,
  fetchFailedCount: 1,
  filterIncludedCount: 3,
  filterExcludedCount: 1,
  manualReviewCount: 2,
  startedAt: new Date("2026-07-26T10:00:00Z"),
  lastCheckpointAt: new Date("2026-07-26T10:01:00Z"),
  completedAt: null,
  pausedAt: null,
  cancelledAt: null,
};

describe("Phase 1A scan progress service", () => {
  it("scopes the scan to the authenticated user and reconciles item counters", async () => {
    const findFirst = jest.fn().mockResolvedValue(scan);
    const groupBy = jest.fn().mockResolvedValue([
      { status: "FETCHED", filterDecision: "INCLUDED", _count: { _all: 3 } },
      { status: "FETCHED", filterDecision: "EXCLUDED", _count: { _all: 1 } },
      {
        status: "PERMANENTLY_FAILED",
        filterDecision: "PENDING",
        _count: { _all: 1 },
      },
    ]);
    const store = {
      emailScanRun: { findFirst },
      emailScanItem: { groupBy },
    } as ScanProgressStore;

    const result = await getScanProgressForUser("user-1", "scan-1", store);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "scan-1", userId: "user-1" } }),
    );
    expect(groupBy).toHaveBeenCalledWith({
      by: ["status", "filterDecision"],
      where: { scanRunId: "scan-1" },
      _count: { _all: true },
    });
    expect(result).toMatchObject({
      scanRunId: "scan-1",
      cacheMatches: true,
      counters: {
        totalDiscovered: 5,
        permanentlyFailedCount: 1,
        fetchedIncludedCount: 3,
        fetchedExcludedCount: 1,
      },
      progress: {
        processedCount: 5,
        remainingCount: 0,
        percentage: 100,
        canComplete: true,
      },
    });
  });

  it("does not query item counts when the tenant-scoped scan does not exist", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const groupBy = jest.fn();
    const store = {
      emailScanRun: { findFirst },
      emailScanItem: { groupBy },
    } as ScanProgressStore;

    await expect(
      getScanProgressForUser("other-user", "scan-1", store),
    ).resolves.toBeNull();
    expect(groupBy).not.toHaveBeenCalled();
  });
});
