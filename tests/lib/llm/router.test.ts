import { selectProvider } from "../../../src/lib/llm/router";

jest.mock("../../../src/lib/llm/quota");
jest.mock("../../../src/lib/llm/circuitBreaker");

import * as quota from "../../../src/lib/llm/quota";
import * as cb from "../../../src/lib/llm/circuitBreaker";

const mockCheckQuota = quota.checkQuota as jest.Mock;
const mockReserveQuota = quota.reserveQuota as jest.Mock;
const mockGetState = cb.getCircuitBreakerState as jest.Mock;
const mockTryProbe = cb.tryAcquireHalfOpenProbe as jest.Mock;

describe("selectProvider", () => {
  beforeEach(() => {
    mockCheckQuota.mockResolvedValue({ allowed: true });
    mockReserveQuota.mockResolvedValue(true);
    mockGetState.mockResolvedValue("CLOSED");
    mockTryProbe.mockResolvedValue(true);
  });
  afterEach(() => jest.resetAllMocks());

  it("selects gemini when candidateCount <= threshold (10)", async () => {
    process.env.LLM_CANDIDATE_THRESHOLD = "10";
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("gemini");
  });

  it("selects openai when candidateCount > threshold", async () => {
    process.env.LLM_CANDIDATE_THRESHOLD = "10";
    const result = await selectProvider(15, 200, 100);
    expect(result.provider).toBe("openai");
  });

  it("falls back to secondary when primary quota denied", async () => {
    process.env.LLM_CANDIDATE_THRESHOLD = "10";
    mockCheckQuota
      .mockResolvedValueOnce({ allowed: false, reason: "rpm" })
      .mockResolvedValueOnce({ allowed: true });
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("openai");
  });

  it("throws ProviderExhaustedError when both providers fail quota", async () => {
    mockCheckQuota.mockResolvedValue({ allowed: false, reason: "rpd" });
    await expect(selectProvider(5, 50, 50)).rejects.toThrow("Both providers exhausted");
  });

  it("skips OPEN circuit and uses fallback", async () => {
    process.env.LLM_CANDIDATE_THRESHOLD = "10";
    mockGetState
      .mockResolvedValueOnce("OPEN")   // gemini
      .mockResolvedValueOnce("CLOSED"); // openai
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("openai");
  });

  it("reserves quota for selected provider", async () => {
    process.env.LLM_CANDIDATE_THRESHOLD = "10";
    const result = await selectProvider(5, 100, 50);
    expect(mockReserveQuota).toHaveBeenCalledWith(result.provider, 1, 100, 50);
  });
});
