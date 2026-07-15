import {
  ProviderBadRequestError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderParseError,
  ProviderExhaustedError,
  ProviderContractError,
  isAvailabilityError,
} from "../../../src/lib/llm/providers/types";

describe("LLM error classes", () => {
  it("ProviderBadRequestError has correct name and provider", () => {
    const err = new ProviderBadRequestError("openai", "bad request");
    expect(err.name).toBe("ProviderBadRequestError");
    expect(err.provider).toBe("openai");
    expect(err instanceof Error).toBe(true);
  });

  it("ProviderAuthError has correct name", () => {
    const err = new ProviderAuthError("gemini", "unauthorized");
    expect(err.name).toBe("ProviderAuthError");
    expect(err.provider).toBe("gemini");
  });

  it("ProviderRateLimitError has correct name", () => {
    const err = new ProviderRateLimitError("openai", "rate limited");
    expect(err.name).toBe("ProviderRateLimitError");
  });

  it("ProviderServerError has correct name", () => {
    const err = new ProviderServerError("gemini", "server error");
    expect(err.name).toBe("ProviderServerError");
  });

  it("ProviderTimeoutError has correct name", () => {
    const err = new ProviderTimeoutError("openai", "timeout");
    expect(err.name).toBe("ProviderTimeoutError");
  });

  it("ProviderParseError has correct name and raw field", () => {
    const err = new ProviderParseError("gemini", "bad json", "raw response here");
    expect(err.name).toBe("ProviderParseError");
    expect(err.raw).toBe("raw response here");
  });

  it("ProviderExhaustedError carries both providers", () => {
    const err = new ProviderExhaustedError("openai", "gemini");
    expect(err.name).toBe("ProviderExhaustedError");
    expect(err.primary).toBe("openai");
    expect(err.fallback).toBe("gemini");
  });
});

describe("error class hierarchy", () => {
  it("ProviderTimeoutError is an availability error", () => {
    const e = new ProviderTimeoutError("gemini", "timed out");
    expect(isAvailabilityError(e)).toBe(true);
  });

  it("ProviderRateLimitError is an availability error", () => {
    const e = new ProviderRateLimitError("gemini", "429");
    expect(isAvailabilityError(e)).toBe(true);
  });

  it("ProviderServerError is an availability error", () => {
    const e = new ProviderServerError("openai", "500");
    expect(isAvailabilityError(e)).toBe(true);
  });

  it("ProviderBadRequestError is NOT an availability error", () => {
    const e = new ProviderBadRequestError("openai", "400");
    expect(isAvailabilityError(e)).toBe(false);
  });

  it("ProviderParseError is NOT an availability error", () => {
    const e = new ProviderParseError("gemini", "bad json", "raw");
    expect(isAvailabilityError(e)).toBe(false);
  });

  it("ProviderContractError is NOT an availability error", () => {
    const e = new ProviderContractError("openai", "missing ids");
    expect(isAvailabilityError(e)).toBe(false);
  });

  it("ProviderAuthError is NOT an availability error (invalid key is not transient)", () => {
    const e = new ProviderAuthError("openai", "401");
    expect(isAvailabilityError(e)).toBe(false);
  });

  it("ProviderContractError has provider and message", () => {
    const e = new ProviderContractError("gemini", "Expected 5 got 2");
    expect(e.provider).toBe("gemini");
    expect(e.message).toBe("Expected 5 got 2");
    expect(e.name).toBe("ProviderContractError");
  });
});
