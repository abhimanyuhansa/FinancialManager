import { checkQuota, reserveQuota, releaseQuota } from "../../../src/lib/llm/quota";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: jest.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
const mockQuery = prisma.$queryRaw as jest.Mock;

describe("checkQuota", () => {
  afterEach(() => mockQuery.mockReset());

  it("returns allowed=true when all windows have capacity", async () => {
    mockQuery.mockResolvedValue([
      { window_type: "rpm", count: 5 },
      { window_type: "tpm", count: 100 },
      { window_type: "rpd", count: 50 },
    ]);
    const result = await checkQuota("gemini", 5);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed=false with reason when RPM exceeded", async () => {
    mockQuery.mockResolvedValue([
      { window_type: "rpm", count: 1000 },
      { window_type: "tpm", count: 100 },
      { window_type: "rpd", count: 50 },
    ]);
    const result = await checkQuota("gemini", 5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("rpm");
  });
});

describe("reserveQuota", () => {
  afterEach(() => mockQuery.mockReset());

  it("returns true when all atomic upserts succeed", async () => {
    mockQuery.mockResolvedValue([{ affected: 1 }]);
    const success = await reserveQuota("openai", 1, 200, 100);
    expect(success).toBe(true);
  });

  it("returns false when a window upsert is rejected", async () => {
    mockQuery
      .mockResolvedValueOnce([{ affected: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ affected: 1 }]);
    const success = await reserveQuota("openai", 1, 200, 100);
    expect(success).toBe(false);
  });
});

describe("releaseQuota", () => {
  afterEach(() => mockQuery.mockReset());

  it("does not throw even if $queryRaw fails (best-effort)", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    await expect(releaseQuota("openai", 1, 200, 100)).resolves.toBeUndefined();
  });
});
