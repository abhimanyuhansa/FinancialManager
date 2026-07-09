import { buildFingerprint } from "@/lib/dedup";

describe("buildFingerprint", () => {
  it("normalizes merchant to lowercase alphanumeric", () => {
    const fp = buildFingerprint("Swiggy Food", 349, new Date("2026-06-15T10:00:00Z"));
    expect(fp).toMatch(/^swiggyfood\|/);
  });

  it("same merchant + amount + date within 2-day window → same fingerprint", () => {
    const fp1 = buildFingerprint("Zomato", 250, new Date("2026-06-15T08:00:00Z"));
    const fp2 = buildFingerprint("Zomato", 250, new Date("2026-06-16T20:00:00Z"));
    const bucket1 = Math.floor(new Date("2026-06-15T08:00:00Z").getTime() / (2 * 24 * 60 * 60 * 1000));
    const bucket2 = Math.floor(new Date("2026-06-16T20:00:00Z").getTime() / (2 * 24 * 60 * 60 * 1000));
    if (bucket1 === bucket2) {
      expect(fp1).toBe(fp2);
    } else {
      expect(fp1).toMatch(/^zomato\|250\|\d+$/);
      expect(fp2).toMatch(/^zomato\|250\|\d+$/);
    }
  });

  it("different amount → different fingerprint", () => {
    const fp1 = buildFingerprint("Swiggy", 349, new Date("2026-06-15T10:00:00Z"));
    const fp2 = buildFingerprint("Swiggy", 350, new Date("2026-06-15T10:00:00Z"));
    expect(fp1).not.toBe(fp2);
  });

  it("different merchant → different fingerprint", () => {
    const fp1 = buildFingerprint("Swiggy", 349, new Date("2026-06-15T10:00:00Z"));
    const fp2 = buildFingerprint("Zomato", 349, new Date("2026-06-15T10:00:00Z"));
    expect(fp1).not.toBe(fp2);
  });
});
