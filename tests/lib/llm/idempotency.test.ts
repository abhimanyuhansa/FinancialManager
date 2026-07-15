import { acquireIdempotencyKey, completeIdempotencyKey, failIdempotencyKey } from "../../../src/lib/llm/idempotency";
import { ParsedEmailItem } from "../../../src/lib/llm/providers/types";

jest.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: jest.fn() },
}));

import { prisma } from "@/lib/prisma";
const mockQuery = prisma.$queryRaw as jest.Mock;

const cachedItems: ParsedEmailItem[] = [
  { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" },
];

describe("acquireIdempotencyKey", () => {
  afterEach(() => mockQuery.mockReset());

  it("returns {status:'claimed'} when new key is inserted (in_flight returned)", async () => {
    mockQuery.mockResolvedValueOnce([{ status: "in_flight", result: null }]);
    const result = await acquireIdempotencyKey("key1");
    expect(result.status).toBe("claimed");
  });

  it("returns {status:'complete', result} when completed row is found", async () => {
    mockQuery.mockResolvedValueOnce([{ status: "complete", result: cachedItems }]);
    const result = await acquireIdempotencyKey("key1");
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.result).toEqual(cachedItems);
    }
  });
});

describe("completeIdempotencyKey", () => {
  afterEach(() => mockQuery.mockReset());

  it("calls $queryRaw to mark key as complete", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(completeIdempotencyKey("key1", cachedItems)).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalled();
  });

  it("does not throw if $queryRaw fails", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    await expect(completeIdempotencyKey("key1", cachedItems)).resolves.toBeUndefined();
  });
});

describe("failIdempotencyKey", () => {
  afterEach(() => mockQuery.mockReset());

  it("calls $queryRaw to mark key as failed", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(failIdempotencyKey("key-fail")).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalled();
  });

  it("does not throw if $queryRaw fails", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    await expect(failIdempotencyKey("key-fail")).resolves.toBeUndefined();
  });
});

describe("acquireIdempotencyKey — poll re-claims on failed row", () => {
  afterEach(() => mockQuery.mockReset());

  it("re-claims immediately when polling finds a failed row (no sleep)", async () => {
    // First call: INSERT conflict — row exists and is NOT expired (empty rows → poll path)
    // Second call (poll SELECT): row status is 'failed' → immediate re-claim attempt
    // Third call (re-claim INSERT): succeeds as in_flight
    mockQuery
      .mockResolvedValueOnce([])                                    // conflict: poll
      .mockResolvedValueOnce([{ status: "failed", result: null }]) // poll sees 'failed'
      .mockResolvedValueOnce([{ status: "in_flight", result: null }]); // re-claim

    const result = await acquireIdempotencyKey("key-failed-poll", Date.now() + 60_000);
    expect(result.status).toBe("claimed");
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});
