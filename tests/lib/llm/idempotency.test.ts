import { acquireIdempotencyKey, completeIdempotencyKey } from "../../../src/lib/llm/idempotency";
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
