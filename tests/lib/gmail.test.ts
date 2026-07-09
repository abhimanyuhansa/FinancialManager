import { classifySenders, buildScanFromDate } from "@/lib/gmail";

const filters = [
  { type: "sender_domain", value: "hdfcbank.com", sourceRank: 1, isActive: true },
  { type: "sender_email", value: "alerts@icicibank.com", sourceRank: 1, isActive: true },
  { type: "subject_keyword", value: "debited", sourceRank: 2, isActive: true },
];

const emails = [
  { id: "msg1", from: "noreply@hdfcbank.com", subject: "Your account debited", date: "2026-01-01" },
  { id: "msg2", from: "alerts@icicibank.com", subject: "Transaction alert", date: "2026-01-02" },
  { id: "msg3", from: "offers@spam.com", subject: "50% off today", date: "2026-01-03" },
  { id: "msg4", from: "bill@airtel.com", subject: "Your bill is ready", date: "2026-01-04" },
  { id: "msg5", from: "noreply@phonepe.com", subject: "Payment debited ₹500", date: "2026-01-05" },
];

describe("classifySenders", () => {
  it("marks filter-matched senders as autoApproved", () => {
    const result = classifySenders(emails, filters);
    const approvedSenders = result.autoApproved.map((s) => s.sender);
    expect(approvedSenders).toContain("noreply@hdfcbank.com");
    expect(approvedSenders).toContain("alerts@icicibank.com");
  });

  it("marks subject_keyword matches as needsReview (low confidence)", () => {
    const result = classifySenders(emails, filters);
    const reviewSenders = result.needsReview.map((s) => s.sender);
    expect(reviewSenders).toContain("noreply@phonepe.com");
  });

  it("excludes non-matching senders entirely", () => {
    const result = classifySenders(emails, filters);
    const allSenders = [
      ...result.autoApproved.map((s) => s.sender),
      ...result.needsReview.map((s) => s.sender),
    ];
    expect(allSenders).not.toContain("offers@spam.com");
    expect(allSenders).not.toContain("bill@airtel.com");
  });

  it("counts emails per sender correctly", () => {
    const multipleEmails = [
      ...emails,
      { id: "msg6", from: "noreply@hdfcbank.com", subject: "Another debit", date: "2026-01-06" },
    ];
    const result = classifySenders(multipleEmails, filters);
    const hdfc = result.autoApproved.find((s) => s.sender === "noreply@hdfcbank.com");
    expect(hdfc?.emailCount).toBe(2);
  });

  it("returns total email count", () => {
    const result = classifySenders(emails, filters);
    expect(result.totalScanned).toBe(5);
    expect(result.financialFound).toBe(3); // hdfc, icici, phonepe
  });
});

describe("buildScanFromDate", () => {
  it("returns date 1 month ago for '1m'", () => {
    const now = new Date("2026-07-09");
    const result = buildScanFromDate("1m", now);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(5); // June (0-indexed)
  });

  it("returns date 3 months ago for '3m'", () => {
    const now = new Date("2026-07-09");
    const result = buildScanFromDate("3m", now);
    expect(result.getMonth()).toBe(3); // April
  });

  it("returns date 6 months ago for '6m'", () => {
    const now = new Date("2026-07-09");
    const result = buildScanFromDate("6m", now);
    expect(result.getMonth()).toBe(0); // January
  });
});
