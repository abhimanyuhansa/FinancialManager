const mockProcessScanWorkerMessage = jest.fn();
jest.mock("@/lib/scan/worker", () => ({
  processScanWorkerMessage: (...args: unknown[]) =>
    mockProcessScanWorkerMessage(...args),
}));

import { POST } from "@/app/api/gmail/scan/worker/route";

describe("POST /api/gmail/scan/worker", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects an unsigned request before executing scan code", async () => {
    const response = await POST(
      new Request("https://example.test/api/gmail/scan/worker", {
        method: "POST",
        body: JSON.stringify({
          scanRunId: "scan-1",
          stage: "DISCOVERY",
          sequence: "0",
        }),
      }),
    );

    expect(response.status).toBe(489);
    expect(response.headers.get("Upstash-NonRetryable-Error")).toBe("true");
    expect(mockProcessScanWorkerMessage).not.toHaveBeenCalled();
  });
});
