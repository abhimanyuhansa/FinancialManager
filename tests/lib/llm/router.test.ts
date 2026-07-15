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
    delete process.env.LLM_PRIMARY_PROVIDER;
    mockCheckQuota.mockResolvedValue({ allowed: true });
    mockReserveQuota.mockResolvedValue(true);
    mockGetState.mockResolvedValue("CLOSED");
    mockTryProbe.mockResolvedValue(true);
  });
  afterEach(() => jest.resetAllMocks());

  it("always selects gemini as primary regardless of candidateCount", async () => {
    const small = await selectProvider(5, 50, 50);
    expect(small.provider).toBe("gemini");

    const large = await selectProvider(25, 200, 100);
    expect(large.provider).toBe("gemini");
  });

  it("respects LLM_PRIMARY_PROVIDER override", async () => {
    process.env.LLM_PRIMARY_PROVIDER = "openai";
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("openai");
  });

  it("falls back to openai when gemini quota denied", async () => {
    mockCheckQuota
      .mockResolvedValueOnce({ allowed: false, reason: "rpm" }) // gemini
      .mockResolvedValueOnce({ allowed: true });                 // openai
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("openai");
  });

  it("throws ProviderExhaustedError when both providers fail quota", async () => {
    mockCheckQuota.mockResolvedValue({ allowed: false, reason: "rpd" });
    await expect(selectProvider(5, 50, 50)).rejects.toThrow("Both providers exhausted");
  });

  it("skips OPEN gemini circuit and uses openai fallback", async () => {
    mockGetState
      .mockResolvedValueOnce("OPEN")   // gemini
      .mockResolvedValueOnce("CLOSED"); // openai
    const result = await selectProvider(5, 50, 50);
    expect(result.provider).toBe("openai");
  });

  it("reserves quota for selected provider", async () => {
    const result = await selectProvider(5, 100, 50);
    expect(mockReserveQuota).toHaveBeenCalledWith(result.provider, 1, 100, 50);
  });
});

describe("selectProvider — deadline budget", () => {
  beforeEach(() => {
    delete process.env.LLM_PRIMARY_PROVIDER;
    mockCheckQuota.mockResolvedValue({ allowed: true });
    mockReserveQuota.mockResolvedValue(true);
    mockGetState.mockResolvedValue("CLOSED");
    mockTryProbe.mockResolvedValue(true);
  });
  afterEach(() => jest.resetAllMocks());

  it("attaches effectiveTimeoutMs to selected provider result", async () => {
    const deadline = Date.now() + 55_000;
    const result = await selectProvider(5, 50, 50, deadline);
    expect(result.effectiveTimeoutMs).toBeGreaterThan(0);
    expect(result.effectiveTimeoutMs).toBeLessThanOrEqual(55_000);
  });

  it("skips provider when remaining budget is less than MIN_PROVIDER_BUDGET_MS", async () => {
    const tightDeadline = Date.now() + 2_000;
    await expect(selectProvider(5, 50, 50, tightDeadline)).rejects.toThrow("Both providers exhausted");
  });

  it("caps effectiveTimeoutMs at configured provider timeout", async () => {
    const generousDeadline = Date.now() + 600_000;
    const result = await selectProvider(5, 50, 50, generousDeadline);
    const maxProviderTimeout = 60_000;
    expect(result.effectiveTimeoutMs).toBeLessThanOrEqual(maxProviderTimeout);
  });
});
