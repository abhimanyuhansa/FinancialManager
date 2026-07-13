import { validateProviderResults } from "../../../src/lib/llm/validate";
import { ProviderParseError } from "../../../src/lib/llm/providers/types";

const makeItem = (emailIndex: number) => ({
  emailIndex,
  isTransaction: true,
  transactions: [
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
  ],
  outcome: "parsed" as const,
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

  it("throws ProviderParseError for wrong count", () => {
    expect(() => validateProviderResults([makeItem(0)], 2, "gemini")).toThrow(ProviderParseError);
  });

  it("throws ProviderParseError for duplicate emailIndex", () => {
    expect(() => validateProviderResults([makeItem(0), makeItem(0)], 2, "gemini")).toThrow(ProviderParseError);
  });

  it("throws ProviderParseError for gap in emailIndex", () => {
    expect(() => validateProviderResults([makeItem(0), makeItem(2)], 2, "gemini")).toThrow(ProviderParseError);
  });

  it("throws ProviderParseError for out-of-range emailIndex", () => {
    expect(() => validateProviderResults([makeItem(5)], 1, "openai")).toThrow(ProviderParseError);
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
});
