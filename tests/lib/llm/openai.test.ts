import { callOpenAIEmailBatch, callOpenAIStatement } from "../../../src/lib/llm/providers/openai";
import {
  ProviderRateLimitError,
  ProviderServerError,
  ProviderAuthError,
  ProviderBadRequestError,
  ProviderParseError,
} from "../../../src/lib/llm/providers/types";

global.fetch = jest.fn();
const mockFetch = global.fetch as jest.Mock;

const makeOpenAIResponse = (items: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(items) } }],
    usage: { prompt_tokens: 80, completion_tokens: 40 },
  }),
});

const makeErrorResponse = (status: number) => ({
  ok: false,
  status,
  json: async () => ({ error: { message: "err" } }),
});

describe("callOpenAIEmailBatch", () => {
  afterEach(() => mockFetch.mockReset());

  it("returns parsed items and token counts on success", async () => {
    const item = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" };
    mockFetch.mockResolvedValueOnce(makeOpenAIResponse([item]));

    const result = await callOpenAIEmailBatch(
      [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
      "sk-test"
    );

    expect(result.items).toHaveLength(1);
    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(40);
  });

  it("throws ProviderRateLimitError on 429", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(429));
    await expect(
      callOpenAIEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key"
      )
    ).rejects.toThrow(ProviderRateLimitError);
  });

  it("throws ProviderAuthError on 401", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
    await expect(
      callOpenAIEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key"
      )
    ).rejects.toThrow(ProviderAuthError);
  });

  it("throws ProviderBadRequestError on 400", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(400));
    await expect(
      callOpenAIEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key"
      )
    ).rejects.toThrow(ProviderBadRequestError);
  });

  it("throws ProviderParseError if response is not array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"not":"array"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    await expect(
      callOpenAIEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key"
      )
    ).rejects.toThrow(ProviderParseError);
  });
});

describe("callOpenAIStatement", () => {
  afterEach(() => mockFetch.mockReset());

  it("returns parsed items on success", async () => {
    const items = [{ date: "2026-07-14", merchant: "Flipkart", amount: 999, type: "expense" }];
    mockFetch.mockResolvedValueOnce(makeOpenAIResponse(items));

    const result = await callOpenAIStatement("statement body", "sk-test");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].merchant).toBe("Flipkart");
  });

  it("throws ProviderServerError on 500", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));
    await expect(callOpenAIStatement("body", "key")).rejects.toThrow(ProviderServerError);
  });
});
