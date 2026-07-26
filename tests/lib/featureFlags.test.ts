import {
  assertLlmParsingEnabled,
  isLegacyTransactionIngestionEnabled,
  isLlmParsingEnabled,
  LlmDisabledError,
} from "@/lib/featureFlags";

describe("feature flags", () => {
  const originalLlmFlag = process.env.LLM_PARSING_ENABLED;
  const originalLegacyFlag = process.env.LEGACY_TRANSACTION_INGESTION_ENABLED;

  afterEach(() => {
    if (originalLlmFlag === undefined) delete process.env.LLM_PARSING_ENABLED;
    else process.env.LLM_PARSING_ENABLED = originalLlmFlag;

    if (originalLegacyFlag === undefined) {
      delete process.env.LEGACY_TRANSACTION_INGESTION_ENABLED;
    } else {
      process.env.LEGACY_TRANSACTION_INGESTION_ENABLED = originalLegacyFlag;
    }
  });

  it.each([undefined, "", "false", "TRUE", "1", "yes"])(
    "safely disables LLM parsing for %p",
    (value) => {
      if (value === undefined) delete process.env.LLM_PARSING_ENABLED;
      else process.env.LLM_PARSING_ENABLED = value;

      expect(isLlmParsingEnabled()).toBe(false);
      expect(() => assertLlmParsingEnabled()).toThrow(LlmDisabledError);
    },
  );

  it("enables LLM parsing only for the exact value true", () => {
    process.env.LLM_PARSING_ENABLED = "true";

    expect(isLlmParsingEnabled()).toBe(true);
    expect(() => assertLlmParsingEnabled()).not.toThrow();
  });

  it("keeps legacy ingestion enabled by default during the interim MVP", () => {
    delete process.env.LEGACY_TRANSACTION_INGESTION_ENABLED;
    expect(isLegacyTransactionIngestionEnabled()).toBe(true);
  });

  it("disables legacy ingestion for cutover when explicitly false", () => {
    process.env.LEGACY_TRANSACTION_INGESTION_ENABLED = "false";
    expect(isLegacyTransactionIngestionEnabled()).toBe(false);
  });

  it("fails closed for malformed legacy flag values", () => {
    process.env.LEGACY_TRANSACTION_INGESTION_ENABLED = "enabled";
    expect(isLegacyTransactionIngestionEnabled()).toBe(false);
  });
});
