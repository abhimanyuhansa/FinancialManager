const mockFetch = jest.fn();
global.fetch = mockFetch;

import { parseEmailTransaction } from "@/lib/gemini";

const FAKE_KEY = "test-key";

function mockGeminiResponse(json: object) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(json) }],
          },
        },
      ],
    }),
  });
}

describe("parseEmailTransaction", () => {
  beforeEach(() => mockFetch.mockClear());

  it("returns parsed transaction on valid response", async () => {
    mockGeminiResponse({
      merchant: "Swiggy",
      amount: 349,
      currency: "INR",
      date: "2026-06-15",
      type: "expense",
      category: "food",
      confidence: 0.95,
    });

    const result = await parseEmailTransaction({
      body: "Your Swiggy order of ₹349 has been placed.",
      senderName: "Swiggy",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).not.toBeNull();
    expect(result!.merchant).toBe("Swiggy");
    expect(result!.amount).toBe(349);
    expect(result!.category).toBe("food");
    expect(result!.needsReview).toBe(false);
  });

  it("sets needsReview = true when confidence < 0.7", async () => {
    mockGeminiResponse({
      merchant: "Unknown",
      amount: 100,
      currency: "INR",
      date: "2026-06-15",
      type: "expense",
      category: "other",
      confidence: 0.5,
    });

    const result = await parseEmailTransaction({
      body: "Some ambiguous email.",
      senderName: "Unknown",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).not.toBeNull();
    expect(result!.needsReview).toBe(true);
  });

  it("returns null when amount <= 0", async () => {
    mockGeminiResponse({
      merchant: "Swiggy",
      amount: 0,
      currency: "INR",
      date: "2026-06-15",
      type: "expense",
      category: "food",
      confidence: 0.9,
    });

    const result = await parseEmailTransaction({
      body: "Zero amount email.",
      senderName: "Swiggy",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).toBeNull();
  });

  it("uses fallbackDate when LLM returns null date", async () => {
    mockGeminiResponse({
      merchant: "Zomato",
      amount: 250,
      currency: "INR",
      date: null,
      type: "expense",
      category: "food",
      confidence: 0.85,
    });

    const result = await parseEmailTransaction({
      body: "Your Zomato order.",
      senderName: "Zomato",
      fallbackDate: "2026-06-20",
      apiKey: FAKE_KEY,
    });

    expect(result).not.toBeNull();
    expect(result!.date).toBe("2026-06-20");
  });

  it("uses senderName when LLM returns null merchant", async () => {
    mockGeminiResponse({
      merchant: null,
      amount: 500,
      currency: "INR",
      date: "2026-06-15",
      type: "expense",
      category: "other",
      confidence: 0.8,
    });

    const result = await parseEmailTransaction({
      body: "Some bank email.",
      senderName: "HDFC Bank",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).not.toBeNull();
    expect(result!.merchant).toBe("HDFC Bank");
  });

  it("returns null when fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => "quota exceeded" });

    const result = await parseEmailTransaction({
      body: "Some email.",
      senderName: "Sender",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).toBeNull();
  });
});
