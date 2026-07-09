import { buildScanFromDate } from "@/lib/gmail";

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
