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
const mockAcquireIdempotency = idempotency.acquireIdempotencyKey as jest.Mock;
const mockCompleteIdempotency = idempotency.completeIdempotencyKey as jest.Mock;
const mockLogCreate = prisma.llmCallLog.create as jest.Mock;

const ctx: LlmCallContext = { userId: "u1", syncJobId: "s1", operationType: "sync" };
const rawItem = { emailIndex: 0, isTransaction: false, transactions: [], outcome: "not_transaction" as const };

describe("parseEmailBatchLLM", () => {
  beforeEach(() => {
    mockAcquireIdempotency.mockResolvedValue({ status: "claimed" });
    mockCompleteIdempotency.mockResolvedValue(undefined);
    mockLogCreate.mockResolvedValue({});
    mockRecordSuccess.mockResolvedValue(undefined);
    mockRecordFailure.mockResolvedValue(undefined);
  });
  afterEach(() => jest.resetAllMocks());

  it("returns validated results on success via gemini and writes LlmCallLog", async () => {
    const selected = { provider: "gemini", isHalfOpenProbe: false, reservedInputTokens: 100, reservedOutputTokens: 50 };
    mockSelectProvider.mockResolvedValue(selected);
    mockCallGemini.mockResolvedValue({ items: [rawItem], inputTokens: 100, outputTokens: 50 });
    mockValidate.mockReturnValue([rawItem]);

    const result = await parseEmailBatchLLM(
      [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
      "batchkey1",
      ctx
    );

    expect(result).toHaveLength(1);
    expect(mockLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "gemini", outcome: "success" }),
      })
    );
  });

  it("returns cached result immediately when idempotency key is complete", async () => {
    mockAcquireIdempotency.mockResolvedValue({ status: "complete", result: [rawItem] });

    const result = await parseEmailBatchLLM(
      [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
      "batchkey-cached",
      ctx
    );

    expect(result).toEqual([rawItem]);
    expect(mockSelectProvider).not.toHaveBeenCalled();
  });

  it("calls openai when gemini is not the selected provider", async () => {
    const selected = { provider: "openai", isHalfOpenProbe: false, reservedInputTokens: 100, reservedOutputTokens: 50 };
    mockSelectProvider.mockResolvedValue(selected);
    mockCallOpenAI.mockResolvedValue({ items: [rawItem], inputTokens: 80, outputTokens: 40 });
    mockValidate.mockReturnValue([rawItem]);

    const result = await parseEmailBatchLLM(
      [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
      "batchkey2",
      ctx
    );

    expect(result).toHaveLength(1);
    expect(mockCallOpenAI).toHaveBeenCalled();
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it("does NOT call recordFailure when error is ProviderContractError", async () => {
    const { ProviderContractError } = await import("../../../src/lib/llm/providers/types");
    const selected = { provider: "gemini" as const, isHalfOpenProbe: false, reservedInputTokens: 100, reservedOutputTokens: 50, effectiveTimeoutMs: 30000 };
    mockSelectProvider.mockResolvedValue(selected);
    mockCallGemini.mockRejectedValue(new ProviderContractError("gemini", "Expected 3 got 1"));

    await expect(
      parseEmailBatchLLM(
        [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
        "batchkey-contract-err",
        ctx
      )
    ).rejects.toThrow("Expected 3 got 1");

    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("DOES call recordFailure when error is ProviderTimeoutError", async () => {
    const { ProviderTimeoutError } = await import("../../../src/lib/llm/providers/types");
    const selected = { provider: "gemini" as const, isHalfOpenProbe: false, reservedInputTokens: 100, reservedOutputTokens: 50, effectiveTimeoutMs: 30000 };
    mockSelectProvider.mockResolvedValue(selected);
    mockCallGemini.mockRejectedValue(new ProviderTimeoutError("gemini", "Timed out after 30000ms"));

    await expect(
      parseEmailBatchLLM(
        [{ emailIndex: 0, body: "test", senderName: "S", fallbackDate: "2026-07-14" }],
        "batchkey-timeout-err",
        ctx
      )
    ).rejects.toThrow("Timed out after 30000ms");

    expect(mockRecordFailure).toHaveBeenCalledWith("gemini");
  });
});
