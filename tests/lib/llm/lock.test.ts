import { acquireLock, releaseLock } from "../../../src/lib/llm/lock";

jest.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: jest.fn() },
}));

import { prisma } from "@/lib/prisma";
const mockQuery = prisma.$queryRaw as jest.Mock;

describe("acquireLock", () => {
  afterEach(() => {
    mockQuery.mockReset();
    jest.useRealTimers();
  });

  it("returns lock context with ownerToken when insert succeeds", async () => {
    mockQuery.mockResolvedValue([{ acquired: true }]);
    const lock = await acquireLock("job123");
    expect(lock.ownerToken).toBeTruthy();
    lock.release();
  });

  it("throws when lock cannot be acquired after maxRetries", async () => {
    mockQuery.mockResolvedValue([]);
    await expect(acquireLock("job123", { maxRetries: 1, retryDelayMs: 0 })).rejects.toThrow(
      "Could not acquire lock"
    );
  });

  it("returns lockLost flag initially false", async () => {
    mockQuery.mockResolvedValue([{ acquired: true }]);
    const lock = await acquireLock("job456");
    expect(lock.lockLost.value).toBe(false);
    lock.release();
  });
});

describe("releaseLock", () => {
  afterEach(() => mockQuery.mockReset());

  it("calls $queryRaw to delete lock row", async () => {
    mockQuery.mockResolvedValue([]);
    await expect(releaseLock("job123", "token123")).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalled();
  });

  it("does not throw if $queryRaw fails (best-effort)", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    await expect(releaseLock("job123", "token123")).resolves.toBeUndefined();
  });
});
