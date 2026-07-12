const mockFetch = jest.fn();
global.fetch = mockFetch;

import { parseEmailTransaction } from "@/lib/gemini";
import { parseEmailBatch } from "@/lib/gemini";

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

const MOCK_API_KEY = "test-key";

function makeGeminiResponse(items: unknown[]) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(items) }]
        }
      }]
    })
  };
}

describe("parseEmailBatch", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns parsed results for valid emails", async () => {
    mockFetch.mockResolvedValue(makeGeminiResponse([
      {
        emailIndex: 0, isTransaction: true, outcome: "parsed",
        transactions: [{ merchant: "Swiggy", amount: 450, currency: "INR", date: "2026-07-08", type: "expense", category: "food", subCategory: "food delivery", confidence: 0.95, needsReview: false, lineItems: null }],
      },
      {
        emailIndex: 1, isTransaction: true, outcome: "parsed",
        transactions: [{ merchant: "Zomato", amount: 320, currency: "INR", date: "2026-07-07", type: "expense", category: "food", subCategory: null, confidence: 0.88, needsReview: false, lineItems: null }],
      },
    ]));

    const inputs = [
      { emailIndex: 0, body: "Your Swiggy order of ₹450...", senderName: "Swiggy", fallbackDate: "2026-07-08" },
      { emailIndex: 1, body: "Your Zomato order of ₹320...", senderName: "Zomato", fallbackDate: "2026-07-07" },
    ];

    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ emailIndex: 0, outcome: "parsed", isTransaction: true });
    expect(results[0].transactions[0]).toMatchObject({ merchant: "Swiggy", amount: 450, category: "food" });
    expect(results[1].transactions[0]).toMatchObject({ merchant: "Zomato", amount: 320 });
  });

  it("marks null-amount items as not_transaction without affecting other items", async () => {
    mockFetch.mockResolvedValue(makeGeminiResponse([
      { emailIndex: 0, isTransaction: false, outcome: "not_transaction", transactions: [] },
      {
        emailIndex: 1, isTransaction: true, outcome: "parsed",
        transactions: [{ merchant: "Amazon", amount: 999, currency: "INR", date: "2026-07-08", type: "expense", category: "shopping", subCategory: null, confidence: 0.9, needsReview: false, lineItems: null }],
      },
    ]));

    const inputs = [
      { emailIndex: 0, body: "Newsletter...", senderName: "newsletter@example.com", fallbackDate: "2026-07-08" },
      { emailIndex: 1, body: "Your Amazon order...", senderName: "Amazon", fallbackDate: "2026-07-08" },
    ];

    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ emailIndex: 0, outcome: "not_transaction" });
    expect(results[1]).toMatchObject({ emailIndex: 1, outcome: "parsed" });
    expect(results[1].transactions[0]).toMatchObject({ merchant: "Amazon", amount: 999 });
  });

  it("returns parse_failed when Gemini omits an emailIndex from the response", async () => {
    mockFetch.mockResolvedValue(makeGeminiResponse([
      {
        emailIndex: 1, isTransaction: true, outcome: "parsed",
        transactions: [{ merchant: "Netflix", amount: 649, currency: "INR", date: "2026-07-08", type: "expense", category: "entertainment", subCategory: "streaming", confidence: 0.99, needsReview: false, lineItems: null }],
      },
    ]));

    const inputs = [
      { emailIndex: 0, body: "Some email...", senderName: "unknown", fallbackDate: "2026-07-08" },
      { emailIndex: 1, body: "Netflix receipt...", senderName: "Netflix", fallbackDate: "2026-07-08" },
    ];

    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results).toHaveLength(2);
    expect(results.find(r => r.emailIndex === 0)).toMatchObject({ outcome: "parse_failed" });
    expect(results.find(r => r.emailIndex === 1)!.transactions[0]).toMatchObject({ merchant: "Netflix" });
  });

  it("returns parse_failed when API call fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 });

    const inputs = [
      { emailIndex: 0, body: "Test...", senderName: "test", fallbackDate: "2026-07-08" },
    ];

    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ emailIndex: 0, outcome: "parse_failed" });
  });

  it("truncates body to 1500 chars and records wasTruncated", async () => {
    const longBody = "x".repeat(3000);
    mockFetch.mockResolvedValue(makeGeminiResponse([
      {
        emailIndex: 0, isTransaction: true, outcome: "parsed",
        transactions: [{ merchant: "HDFC", amount: 5000, currency: "INR", date: "2026-07-08", type: "expense", category: "finance", subCategory: null, confidence: 0.9, needsReview: false, lineItems: null }],
      },
    ]));

    const inputs = [{ emailIndex: 0, body: longBody, senderName: "HDFC", fallbackDate: "2026-07-08" }];
    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results[0].wasTruncated).toBe(true);
    expect(results[0].bodyLengthRaw).toBe(3000);
    expect(results[0].bodyLengthSent).toBe(1500);
  });
});
