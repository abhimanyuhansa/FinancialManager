import { callGeminiEmailBatch, callGeminiStatement } from "../../../src/lib/llm/providers/gemini";
import {
  ProviderRateLimitError,
  ProviderServerError,
  ProviderAuthError,
  ProviderBadRequestError,
} from "../../../src/lib/llm/providers/types";

global.fetch = jest.fn();
const mockFetch = global.fetch as jest.Mock;

const makeGeminiResponse = (items: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  }),
});

const makeErrorResponse = (status: number) => ({
  ok: false,
  status,
  text: async () => "error body",
});

describe("callGeminiEmailBatch", () => {
  afterEach(() => mockFetch.mockReset());

  it("returns parsed items and token counts on success", async () => {
    const item = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" };
    mockFetch.mockResolvedValueOnce(makeGeminiResponse([item]));

    const result = await callGeminiEmailBatch(
      [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
      "apikey123"
    );

    expect(result.items).toHaveLength(1);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it("throws ProviderRateLimitError on 429", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(429));
    await expect(
      callGeminiEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key"
      )
    ).rejects.toThrow(ProviderRateLimitError);
  });

  it("throws ProviderServerError on 500", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));
    await expect(
      callGeminiEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key"
      )
    ).rejects.toThrow(ProviderServerError);
  });

  it("throws ProviderAuthError on 401", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
    await expect(
      callGeminiEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key"
      )
    ).rejects.toThrow(ProviderAuthError);
  });

  it("throws ProviderBadRequestError on 400", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(400));
    await expect(
      callGeminiEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key"
      )
    ).rejects.toThrow(ProviderBadRequestError);
  });
});

describe("callGeminiStatement", () => {
  afterEach(() => mockFetch.mockReset());

  it("returns parsed items on success", async () => {
    const items = [{ date: "2026-07-14", merchant: "Amazon", amount: 500, type: "expense" }];
    mockFetch.mockResolvedValueOnce(makeGeminiResponse(items));

    const result = await callGeminiStatement("statement body", "apikey123");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].merchant).toBe("Amazon");
  });
});
