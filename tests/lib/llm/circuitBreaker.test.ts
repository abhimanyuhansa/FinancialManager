import {
  getCircuitBreakerState,
  recordSuccess,
  recordFailure,
  tryAcquireHalfOpenProbe,
} from "../../../src/lib/llm/circuitBreaker";

jest.mock("@/lib/prisma", () => ({
  prisma: {
    llmCircuitBreaker: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
const mockFindUnique = prisma.llmCircuitBreaker.findUnique as jest.Mock;
const mockUpsert = prisma.llmCircuitBreaker.upsert as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;

describe("getCircuitBreakerState", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns CLOSED when no record exists", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const state = await getCircuitBreakerState("openai");
    expect(state).toBe("CLOSED");
  });

  it("returns OPEN when record state is OPEN and not expired", async () => {
    mockFindUnique.mockResolvedValueOnce({
      state: "OPEN",
      openedAt: new Date(Date.now() - 10_000),
    });
    const state = await getCircuitBreakerState("openai");
    expect(state).toBe("OPEN");
  });

  it("returns HALF_OPEN when OPEN duration has elapsed", async () => {
    const halfOpenAfterMs = Number(process.env.CIRCUIT_BREAKER_HALF_OPEN_MS ?? 60_000);
    mockFindUnique.mockResolvedValueOnce({
      state: "OPEN",
      openedAt: new Date(Date.now() - halfOpenAfterMs - 1000),
    });
    const state = await getCircuitBreakerState("openai");
    expect(state).toBe("HALF_OPEN");
  });

  it("returns CLOSED when state is CLOSED", async () => {
    mockFindUnique.mockResolvedValueOnce({ state: "CLOSED", openedAt: null });
    const state = await getCircuitBreakerState("gemini");
    expect(state).toBe("CLOSED");
  });
});

describe("tryAcquireHalfOpenProbe", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns true when CAS update affects 1 row", async () => {
    mockQueryRaw.mockResolvedValueOnce([{ affected: 1 }]);
    const got = await tryAcquireHalfOpenProbe("gemini");
    expect(got).toBe(true);
  });

  it("returns false when CAS update affects 0 rows", async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    const got = await tryAcquireHalfOpenProbe("gemini");
    expect(got).toBe(false);
  });
});

describe("recordSuccess", () => {
  afterEach(() => jest.resetAllMocks());

  it("calls upsert to reset circuit breaker to CLOSED", async () => {
    mockUpsert.mockResolvedValueOnce({});
    await recordSuccess("openai");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: "openai" } })
    );
  });
});

describe("recordFailure", () => {
  afterEach(() => jest.resetAllMocks());

  it("increments failure count", async () => {
    mockUpsert.mockResolvedValueOnce({});
    mockFindUnique.mockResolvedValueOnce({ consecutiveFailures: 1 });
    await recordFailure("gemini");
    expect(mockUpsert).toHaveBeenCalled();
  });
});
