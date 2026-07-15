import { validateProviderResults } from "../../../src/lib/llm/validate";
import { ProviderParseError, ProviderContractError } from "../../../src/lib/llm/providers/types";

const makeItem = (emailIndex: number, isTransaction = true) => ({
  emailIndex,
  isTransaction,
  transactions: isTransaction
    ? [
        {
          merchant: "M",
          amount: 100,
          currency: "INR",
          date: "2026-07-14",
          type: "expense" as const,
          category: "other",
          subCategory: null,
          confidence: 0.9,
          needsReview: false,
          lineItems: null,
        },
      ]
    : [],
  outcome: isTransaction ? ("parsed" as const) : ("not_transaction" as const),
});

describe("validateProviderResults", () => {
  it("passes for valid single result", () => {
    const out = validateProviderResults([makeItem(0)], 1, "gemini");
    expect(out).toHaveLength(1);
    expect(out[0].emailIndex).toBe(0);
  });

  it("passes for valid multi result", () => {
    const out = validateProviderResults([makeItem(0), makeItem(1), makeItem(2)], 3, "openai");
    expect(out).toHaveLength(3);
  });

  it("throws ProviderContractError for wrong count (not ProviderParseError)", () => {
    expect(() => validateProviderResults([makeItem(0)], 2, "gemini")).toThrow(ProviderContractError);
  });

  it("throws ProviderContractError for duplicate emailIndex", () => {
    expect(() => validateProviderResults([makeItem(0), makeItem(0)], 2, "gemini")).toThrow(ProviderContractError);
  });

  it("throws ProviderContractError for gap in emailIndex", () => {
    expect(() => validateProviderResults([makeItem(0), makeItem(2)], 2, "gemini")).toThrow(ProviderContractError);
  });

  it("throws ProviderContractError for out-of-range emailIndex", () => {
    expect(() => validateProviderResults([makeItem(5)], 1, "openai")).toThrow(ProviderContractError);
  });

  it("returns insufficient_data outcome for invalid transaction field (not a throw)", () => {
    const bad = {
      emailIndex: 0,
      isTransaction: true,
      transactions: [
        {
          merchant: "M",
          amount: -1,
          currency: "INR",
          date: "2026-07-14",
          type: "expense" as const,
          category: "other",
          subCategory: null,
          confidence: 0.9,
          needsReview: false,
          lineItems: null,
        },
      ],
      outcome: "parsed" as const,
    };
    const out = validateProviderResults([bad], 1, "gemini");
    expect(out[0].outcome).toBe("insufficient_data");
    expect(out[0].transactions).toHaveLength(0);
  });

  it("handles not_transaction items correctly", () => {
    const items = [makeItem(0, false), makeItem(1, true), makeItem(2, false)];
    const out = validateProviderResults(items, 3, "openai");
    expect(out).toHaveLength(3);
    expect(out[0].isTransaction).toBe(false);
    expect(out[0].outcome).toBe("not_transaction");
    expect(out[1].outcome).toBe("parsed");
  });

  it("validates batch of 12 with mixed items", () => {
    const items = Array.from({ length: 12 }, (_, i) => makeItem(i, i % 3 !== 0));
    const out = validateProviderResults(items, 12, "openai");
    expect(out).toHaveLength(12);
  });
});
