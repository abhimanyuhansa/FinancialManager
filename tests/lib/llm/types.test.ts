import {
  ProviderBadRequestError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderParseError,
  ProviderExhaustedError,
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
