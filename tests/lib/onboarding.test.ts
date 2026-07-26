import { buildScanFromDate, resolveLegacySyncFromDate } from "@/lib/gmail";

describe("lookback period → date", () => {
  it("1m gives roughly 30 days ago", () => {
    const now = new Date("2026-07-09");
    const d = buildScanFromDate("1m", now);
    const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(28);
    expect(diffDays).toBeLessThanOrEqual(32);
  });

  it("6m gives roughly 180 days ago", () => {
    const now = new Date("2026-07-09");
    const d = buildScanFromDate("6m", now);
    const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(178);
    expect(diffDays).toBeLessThanOrEqual(185);
  });
});

describe("legacy onboarding sync window", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");

  it("defaults a first scan to six months", () => {
    const result = resolveLegacySyncFromDate(
      { gmailSyncedAt: null, syncFromDate: null },
      undefined,
      now,
    );

    expect(result.fromDate).toEqual(new Date("2026-01-26T12:00:00.000Z"));
    expect(result.persistSelectedStart).toBe(false);
  });

  it("marks a changed onboarding period for persistence", () => {
    const result = resolveLegacySyncFromDate(
      { gmailSyncedAt: null, syncFromDate: null },
      "3m",
      now,
    );

    expect(result.fromDate).toEqual(new Date("2026-04-26T12:00:00.000Z"));
    expect(result.persistSelectedStart).toBe(true);
  });

  it("uses the last successful watermark with a one-day overlap later", () => {
    const result = resolveLegacySyncFromDate(
      {
        gmailSyncedAt: new Date("2026-07-20T10:00:00.000Z"),
        syncFromDate: new Date("2026-01-01T00:00:00.000Z"),
      },
      "1m",
      now,
    );

    expect(result.fromDate).toEqual(new Date("2026-07-19T10:00:00.000Z"));
    expect(result.persistSelectedStart).toBe(false);
  });
});
