import { parseEmailBatchLLM, parseStatementLLM } from "../../../src/lib/llm/index";
import { LlmCallContext } from "../../../src/lib/llm/providers/types";

jest.mock("../../../src/lib/llm/router");
jest.mock("../../../src/lib/llm/providers/gemini");
jest.mock("../../../src/lib/llm/providers/openai");
jest.mock("../../../src/lib/llm/validate");
jest.mock("../../../src/lib/llm/circuitBreaker");
jest.mock("../../../src/lib/llm/idempotency");
jest.mock("@/lib/prisma", () => ({
  prisma: { llmCallLog: { create: jest.fn() } },
}));

import * as router from "../../../src/lib/llm/router";
import * as gemini from "../../../src/lib/llm/providers/gemini";
import * as openai from "../../../src/lib/llm/providers/openai";
import * as validate from "../../../src/lib/llm/validate";
import * as cb from "../../../src/lib/llm/circuitBreaker";
import * as idempotency from "../../../src/lib/llm/idempotency";
import { prisma } from "@/lib/prisma";

const mockSelectProvider = router.selectProvider as jest.Mock;
const mockCallGemini = gemini.callGeminiEmailBatch as jest.Mock;
const mockCallOpenAI = openai.callOpenAIEmailBatch as jest.Mock;
const mockValidate = validate.validateProviderResults as jest.Mock;
const mockRecordSuccess = cb.recordSuccess as jest.Mock;
const mockRecordFailure = cb.recordFailure as jest.Mock;
const mockReleaseHalfOpenProbe = cb.releaseHalfOpenProbe as jest.Mock;
const mockAcquireIdempotency = idempotency.acquireIdempotencyKey as jest.Mock;
const mockCompleteIdempotency = idempotency.completeIdempotencyKey as jest.Mock;
const mockFailIdempotency = idempotency.failIdempotencyKey as jest.Mock;
const mockLogCreate = prisma.llmCallLog.create as jest.Mock;

const ctx: LlmCallContext = { userId: "u1", syncJobId: "s1", operationType: "sync" };
const rawItem = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" as const };
const input = { emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" };
const selectedGemini = { provider: "gemini" as const, isHalfOpenProbe: false, reservedInputTokens: 100, reservedOutputTokens: 50, effectiveTimeoutMs: 30_000 };
const selectedOpenAI = { provider: "openai" as const, isHalfOpenProbe: false, reservedInputTokens: 100, reservedOutputTokens: 50, effectiveTimeoutMs: 30_000 };

describe("parseEmailBatchLLM", () => {
  beforeEach(() => {
    mockAcquireIdempotency.mockResolvedValue({ status: "claimed" });
    mockCompleteIdempotency.mockResolvedValue(undefined);
    mockFailIdempotency.mockResolvedValue(undefined);
    mockLogCreate.mockResolvedValue({});
    mockRecordSuccess.mockResolvedValue(undefined);
    mockRecordFailure.mockResolvedValue(undefined);
    mockReleaseHalfOpenProbe.mockResolvedValue(undefined);
  });
  afterEach(() => jest.resetAllMocks());

  it("returns validated results on success via gemini and writes LlmCallLog", async () => {
    mockSelectProvider.mockResolvedValue(selectedGemini);
    mockCallGemini.mockResolvedValue({ items: [rawItem], inputTokens: 100, outputTokens: 50 });
    mockValidate.mockReturnValue([rawItem]);

    const result = await parseEmailBatchLLM([input], "batchkey1", ctx);

    expect(result).toHaveLength(1);
    expect(mockLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "gemini", outcome: "success" }),
      })
    );
  });

  it("returns cached result immediately when idempotency key is complete", async () => {
    mockAcquireIdempotency.mockResolvedValue({ status: "complete", result: [rawItem] });

    const result = await parseEmailBatchLLM([input], "batchkey-cached", ctx);

    expect(result).toEqual([rawItem]);
    expect(mockSelectProvider).not.toHaveBeenCalled();
  });

  it("calls openai when gemini is not the selected provider", async () => {
    mockSelectProvider.mockResolvedValue(selectedOpenAI);
    mockCallOpenAI.mockResolvedValue({ items: [rawItem], inputTokens: 80, outputTokens: 40 });
    mockValidate.mockReturnValue([rawItem]);

    const result = await parseEmailBatchLLM([input], "batchkey2", ctx);

    expect(result).toHaveLength(1);
    expect(mockCallOpenAI).toHaveBeenCalled();
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it("does NOT call recordFailure when error is ProviderContractError", async () => {
    const { ProviderContractError } = await import("../../../src/lib/llm/providers/types");
    mockSelectProvider.mockResolvedValue(selectedGemini);
    mockCallGemini.mockRejectedValue(new ProviderContractError("gemini", "Expected 3 got 1"));

    await expect(parseEmailBatchLLM([input], "batchkey-contract-err", ctx)).rejects.toThrow("Expected 3 got 1");

    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("DOES call recordFailure when error is ProviderTimeoutError", async () => {
    const { ProviderTimeoutError } = await import("../../../src/lib/llm/providers/types");
    mockSelectProvider.mockResolvedValue(selectedGemini);
    mockCallGemini.mockRejectedValue(new ProviderTimeoutError("gemini", "Timed out after 30000ms"));

    await expect(parseEmailBatchLLM([input], "batchkey-timeout-err", ctx)).rejects.toThrow("Timed out after 30000ms");

    expect(mockRecordFailure).toHaveBeenCalledWith("gemini");
  });

  it("falls back to OpenAI when Gemini throws a timeout (availability) error", async () => {
    const { ProviderTimeoutError } = await import("../../../src/lib/llm/providers/types");
    mockSelectProvider
      .mockResolvedValueOnce(selectedGemini)   // attempt 1: Gemini
      .mockResolvedValueOnce(selectedOpenAI);  // attempt 2: OpenAI
    mockCallGemini.mockRejectedValue(new ProviderTimeoutError("gemini", "Timed out after 30000ms"));
    mockCallOpenAI.mockResolvedValue({ items: [rawItem], inputTokens: 80, outputTokens: 40 });
    mockValidate.mockReturnValue([rawItem]);

    const result = await parseEmailBatchLLM([input], "batchkey-fallback", ctx);

    expect(result).toEqual([rawItem]);
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
    expect(mockCallOpenAI).toHaveBeenCalledTimes(1);
    expect(mockRecordFailure).toHaveBeenCalledWith("gemini");
    expect(mockRecordSuccess).toHaveBeenCalledWith("openai");
    expect(mockCompleteIdempotency).toHaveBeenCalled();
  });

  it("does NOT retry on ProviderContractError (non-availability error stops the loop)", async () => {
    const { ProviderContractError } = await import("../../../src/lib/llm/providers/types");
    mockSelectProvider.mockResolvedValue(selectedGemini);
    mockCallGemini.mockRejectedValue(new ProviderContractError("gemini", "Bad shape"));

    await expect(parseEmailBatchLLM([input], "batchkey-no-retry", ctx)).rejects.toThrow("Bad shape");

    expect(mockSelectProvider).toHaveBeenCalledTimes(1);
    expect(mockCallOpenAI).not.toHaveBeenCalled();
  });

  it("calls failIdempotencyKey when both attempts fail", async () => {
    const { ProviderTimeoutError } = await import("../../../src/lib/llm/providers/types");
    mockSelectProvider
      .mockResolvedValueOnce(selectedGemini)
      .mockResolvedValueOnce(selectedOpenAI);
    mockCallGemini.mockRejectedValue(new ProviderTimeoutError("gemini", "Timed out"));
    mockCallOpenAI.mockRejectedValue(new ProviderTimeoutError("openai", "Timed out"));

    await expect(parseEmailBatchLLM([input], "batchkey-both-fail", ctx)).rejects.toThrow();

    expect(mockFailIdempotency).toHaveBeenCalledWith("batchkey-both-fail");
    expect(mockCompleteIdempotency).not.toHaveBeenCalled();
  });

  it("calls failIdempotencyKey when router exhausts all providers", async () => {
    mockSelectProvider.mockRejectedValue(new Error("Both providers exhausted"));

    await expect(parseEmailBatchLLM([input], "batchkey-router-fail", ctx)).rejects.toThrow("Both providers exhausted");

    expect(mockFailIdempotency).toHaveBeenCalledWith("batchkey-router-fail");
  });

  it("passes effectiveTimeoutMs from selected provider to callGeminiEmailBatch", async () => {
    const selectedWithTimeout = { ...selectedGemini, effectiveTimeoutMs: 45_000 };
    mockSelectProvider.mockResolvedValue(selectedWithTimeout);
    mockCallGemini.mockResolvedValue({ items: [rawItem], inputTokens: 100, outputTokens: 50 });
    mockValidate.mockReturnValue([rawItem]);

    await parseEmailBatchLLM([input], "batchkey-timeout-passthrough", ctx);

    expect(mockCallGemini).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      45_000,
    );
  });
});
