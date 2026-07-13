import {
  SCHEMA_VERSION,
  EMAIL_JSON_SCHEMA,
  BATCH_SYSTEM_PROMPT,
  buildBatchUserPrompt,
  STATEMENT_SYSTEM_PROMPT,
  buildStatementUserPrompt,
  estimateInputTokens,
} from "../../../src/lib/llm/prompts";

describe("prompts", () => {
  it("SCHEMA_VERSION is a non-empty string", () => {
    expect(typeof SCHEMA_VERSION).toBe("string");
    expect(SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  it("EMAIL_JSON_SCHEMA is an object with type=array", () => {
    expect(EMAIL_JSON_SCHEMA.type).toBe("array");
  });

  it("BATCH_SYSTEM_PROMPT contains transaction parsing instructions", () => {
    expect(BATCH_SYSTEM_PROMPT).toContain("transaction");
  });

  it("buildBatchUserPrompt includes emailIndex in output", () => {
    const prompt = buildBatchUserPrompt([
      { emailIndex: 0, body: "hello", senderName: "HDFC", fallbackDate: "2026-07-14" },
    ]);
    expect(prompt).toContain("emailIndex");
    expect(prompt).toContain("0");
  });

  it("STATEMENT_SYSTEM_PROMPT mentions JSON array", () => {
    expect(STATEMENT_SYSTEM_PROMPT).toContain("JSON array");
  });

  it("buildStatementUserPrompt wraps the body", () => {
    const prompt = buildStatementUserPrompt("some statement body");
    expect(prompt).toContain("some statement body");
  });

  it("estimateInputTokens returns a positive number", () => {
    const tokens = estimateInputTokens([
      { emailIndex: 0, body: "debit Rs.500 from HDFC", senderName: "HDFC", fallbackDate: "2026-07-14" },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});
