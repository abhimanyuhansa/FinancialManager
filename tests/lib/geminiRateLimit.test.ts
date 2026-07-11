import { checkGeminiRateLimit, incrementGeminiUsage } from "@/lib/geminiRateLimit";
import { prisma } from "@/lib/prisma";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    geminiUsageLog: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

describe("checkGeminiRateLimit", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns ok when callCount is below 1400", async () => {
    (prisma.geminiUsageLog.findUnique as jest.Mock).mockResolvedValue({ callCount: 100, date: "2026-07-12" });
    const result = await checkGeminiRateLimit();
    expect(result.allowed).toBe(true);
  });

  it("returns rate_limited when callCount >= 1400", async () => {
    (prisma.geminiUsageLog.findUnique as jest.Mock).mockResolvedValue({ callCount: 1400, date: "2026-07-12" });
    const result = await checkGeminiRateLimit();
    expect(result.allowed).toBe(false);
    expect(result.resumesAt).toBeTruthy();
  });

  it("returns ok when no log exists yet (first call today)", async () => {
    (prisma.geminiUsageLog.findUnique as jest.Mock).mockResolvedValue(null);
    const result = await checkGeminiRateLimit();
    expect(result.allowed).toBe(true);
  });
});

describe("incrementGeminiUsage", () => {
  it("upserts with increment", async () => {
    (prisma.geminiUsageLog.upsert as jest.Mock).mockResolvedValue({ callCount: 1 });
    await incrementGeminiUsage();
    expect(prisma.geminiUsageLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ callCount: expect.anything() }),
      })
    );
  });
});
