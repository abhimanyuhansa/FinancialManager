const mockPrisma = {
  parseLog: {
    findMany: jest.fn(),
  },
};
jest.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { lookupExactCache } from "@/lib/exactResultCache";

beforeEach(() => jest.clearAllMocks());

describe("lookupExactCache", () => {
  it("returns a map with transactionId for msgs that have a parsed ParseLog", async () => {
    mockPrisma.parseLog.findMany.mockResolvedValue([
      { gmailMsgId: "msg1", transactionId: "tx1", outcome: "inserted" },
    ]);

    const result = await lookupExactCache("user1", ["msg1", "msg2"]);
    expect(result.get("msg1")).toBe("tx1");
    expect(result.has("msg2")).toBe(false);
  });

  it("returns empty map when no hits", async () => {
    mockPrisma.parseLog.findMany.mockResolvedValue([]);
    const result = await lookupExactCache("user1", ["msg1"]);
    expect(result.size).toBe(0);
  });

  it("makes exactly one DB query regardless of input size", async () => {
    mockPrisma.parseLog.findMany.mockResolvedValue([]);
    await lookupExactCache("user1", ["a", "b", "c", "d", "e"]);
    expect(mockPrisma.parseLog.findMany).toHaveBeenCalledTimes(1);
  });

  it("excludes parse logs without a transactionId", async () => {
    mockPrisma.parseLog.findMany.mockResolvedValue([
      { gmailMsgId: "msg1", transactionId: null, outcome: "parse_failed" },
    ]);
    const result = await lookupExactCache("user1", ["msg1"]);
    expect(result.has("msg1")).toBe(false);
  });
});
