export class LlmDisabledError extends Error {
  constructor() {
    super("LLM parsing is disabled");
    this.name = "LlmDisabledError";
  }
}

export function isLlmParsingEnabled(): boolean {
  return process.env.LLM_PARSING_ENABLED === "true";
}

export function isLegacyTransactionIngestionEnabled(): boolean {
  const configured = process.env.LEGACY_TRANSACTION_INGESTION_ENABLED;

  // The owner-approved interim MVP keeps the legacy deterministic ingestion
  // path active. Phase 1A cutover will explicitly set this flag to "false".
  if (configured === undefined || configured === "") return true;
  return configured === "true";
}

export function assertLlmParsingEnabled(): void {
  if (!isLlmParsingEnabled()) {
    throw new LlmDisabledError();
  }
}
