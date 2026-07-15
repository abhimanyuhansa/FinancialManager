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

// OpenAI email batch expects { results: [...] } wrapper (json_schema format)
const makeOpenAIEmailResponse = (items: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify({ results: items }) } }],
    usage: { prompt_tokens: 80, completion_tokens: 40 },
  }),
});

// OpenAI statement returns a plain array
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
    mockFetch.mockResolvedValueOnce(makeOpenAIEmailResponse([item]));

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

describe("callOpenAIEmailBatch — finish_reason handling", () => {
  afterEach(() => mockFetch.mockReset());

  const makeResponseWithFinishReason = (items: unknown[], finishReason: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ results: items }) }, finish_reason: finishReason }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  });

  it("throws ProviderContractError when finish_reason is length (output truncated)", async () => {
    const { ProviderContractError } = await import("../../../src/lib/llm/providers/types");
    const item = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" };
    mockFetch.mockResolvedValueOnce(makeResponseWithFinishReason([item], "length"));
    await expect(
      callOpenAIEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key",
        1
      )
    ).rejects.toThrow(ProviderContractError);
  });

  it("throws ProviderContractError when finish_reason is content_filter", async () => {
    const { ProviderContractError } = await import("../../../src/lib/llm/providers/types");
    mockFetch.mockResolvedValueOnce(makeResponseWithFinishReason([], "content_filter"));
    await expect(
      callOpenAIEmailBatch(
        [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
        "key",
        1
      )
    ).rejects.toThrow(ProviderContractError);
  });

  it("succeeds when finish_reason is stop", async () => {
    const item = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" };
    mockFetch.mockResolvedValueOnce(makeResponseWithFinishReason([item], "stop"));
    const result = await callOpenAIEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key",
      1
    );
    expect(result.items).toHaveLength(1);
  });
});

describe("callOpenAIEmailBatch — schema includes candidateCount", () => {
  afterEach(() => mockFetch.mockReset());

  it("passes candidateCount in the request body schema as minItems/maxItems", async () => {
    const item = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction", subjectTemplate: "", bodyTemplate: "" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ results: [item] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    });

    await callOpenAIEmailBatch(
      [{ emailIndex: 0, body: "t", senderName: "S", fallbackDate: "2026-07-14" }],
      "key",
      1
    );

    const calledBody = JSON.parse((mockFetch as jest.Mock).mock.calls[0][1].body);
    const resultsSchema = calledBody.response_format.json_schema.schema.properties.results;
    expect(resultsSchema.minItems).toBe(1);
    expect(resultsSchema.maxItems).toBe(1);
  });
});
