import { matchesEmailFilter } from "@/lib/emailFilter";

const filters = [
  { type: "sender_domain", value: "hdfcbank.com", sourceRank: 1, isActive: true },
  { type: "sender_email", value: "alerts@icicibank.com", sourceRank: 1, isActive: true },
  { type: "subject_keyword", value: "transaction alert", sourceRank: 3, isActive: true },
  { type: "sender_domain", value: "spam.com", sourceRank: 3, isActive: false },
];

describe("matchesEmailFilter", () => {
  it("matches sender_domain filter", () => {
    const result = matchesEmailFilter(
      { from: "noreply@hdfcbank.com", subject: "Your account" },
      filters
    );
    expect(result).toEqual({ matched: true, sourceRank: 1 });
  });

  it("matches sender_email filter exactly", () => {
    const result = matchesEmailFilter(
      { from: "alerts@icicibank.com", subject: "Debit" },
      filters
    );
    expect(result).toEqual({ matched: true, sourceRank: 1 });
  });

  it("matches subject_keyword case-insensitive", () => {
    const result = matchesEmailFilter(
      { from: "noreply@somebank.com", subject: "Transaction Alert: INR 500" },
      filters
    );
    expect(result).toEqual({ matched: true, sourceRank: 3 });
  });

  it("does not match inactive filter", () => {
    const result = matchesEmailFilter(
      { from: "offer@spam.com", subject: "Buy now" },
      filters
    );
    expect(result).toEqual({ matched: false });
  });

  it("returns lowest sourceRank when multiple filters match", () => {
    const result = matchesEmailFilter(
      { from: "alerts@hdfcbank.com", subject: "Transaction Alert: INR 200" },
      filters
    );
    expect(result).toEqual({ matched: true, sourceRank: 1 });
  });

  it("no match returns false", () => {
    const result = matchesEmailFilter(
      { from: "newsletter@random.com", subject: "Weekly digest" },
      filters
    );
    expect(result).toEqual({ matched: false });
  });
});
