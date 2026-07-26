import { workerDeduplicationId } from "@/lib/scan/scheduler";
import { resolvePhase1aScanStart } from "@/lib/scan/scanDomainService";

describe("Phase 1A scan scheduling", () => {
  it("creates a deterministic idempotency key per run, stage and sequence", () => {
    expect(
      workerDeduplicationId({
        scanRunId: "scan-123",
        stage: "FETCH",
        sequence: "42",
      }),
    ).toBe("scan-123:FETCH:42");
  });
});

describe("Phase 1A scan watermark", () => {
  it("uses six months for the first scan", () => {
    expect(
      resolvePhase1aScanStart(
        null,
        "6m",
        new Date("2026-07-26T12:00:00.000Z"),
      ),
    ).toEqual(new Date("2026-01-26T12:00:00.000Z"));
  });

  it("uses a one-minute overlap from the last successful scan boundary", () => {
    expect(
      resolvePhase1aScanStart(
        new Date("2026-07-25T12:00:00.000Z"),
        "6m",
        new Date("2026-07-26T12:00:00.000Z"),
      ),
    ).toEqual(new Date("2026-07-25T11:59:00.000Z"));
  });
});
