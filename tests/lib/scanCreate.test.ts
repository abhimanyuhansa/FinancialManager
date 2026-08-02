import type { CreateScanRequest, CreateScanResult } from "@/lib/scan/types";

describe("scan creation types", () => {
  it("CreateScanRequest has required fields", () => {
    const req: CreateScanRequest = {
      userId: "u1",
      gmailAccountId: "a1",
      clientRequestId: "req-001",
      filterName: "My Filter",
      gmailQuery: "from:bank",
      fromDate: new Date("2026-01-01"),
      toDate: new Date("2026-07-01"),
    };
    expect(req.userId).toBe("u1");
  });

  it("CreateScanResult has scanRunId and status", () => {
    const result: CreateScanResult = {
      scanRunId: "run-1",
      status: "CREATED",
      created: true,
    };
    expect(result.status).toBe("CREATED");
  });
});
