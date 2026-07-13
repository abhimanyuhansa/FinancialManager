export type LLMProvider = "openai" | "gemini";

export type ParsedEmailItem = {
  emailIndex: number;
  isTransaction: boolean;
  transactions: Array<{
    merchant: string;
    amount: number;
    currency: string;
    date: string;
    type: "expense" | "income";
    category: string;
    subCategory: string | null;
    confidence: number;
    needsReview: boolean;
    lineItems: Array<{ name: string; amount: number; subCategory?: string }> | null;
  }>;
  outcome: "parsed" | "not_transaction" | "parse_failed" | "insufficient_data";
  subjectTemplate?: string;
  bodyTemplate?: string;
};

export type StatementItem = {
  date: string;
  merchant: string;
  amount: number;
  type: "expense" | "debit" | "credit" | "income";
};

export type ProviderCallResult = {
  items: ParsedEmailItem[];
  inputTokens: number;
  outputTokens: number;
};

export type StatementCallResult = {
  items: StatementItem[];
  inputTokens: number;
  outputTokens: number;
};

abstract class LLMError extends Error {
  abstract readonly name: string;
  readonly provider: LLMProvider;
  constructor(provider: LLMProvider, message: string) {
    super(message);
    this.provider = provider;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ProviderBadRequestError extends LLMError {
  readonly name = "ProviderBadRequestError" as const;
}
export class ProviderAuthError extends LLMError {
  readonly name = "ProviderAuthError" as const;
}
export class ProviderRateLimitError extends LLMError {
  readonly name = "ProviderRateLimitError" as const;
}
export class ProviderServerError extends LLMError {
  readonly name = "ProviderServerError" as const;
}
export class ProviderTimeoutError extends LLMError {
  readonly name = "ProviderTimeoutError" as const;
}
export class ProviderParseError extends LLMError {
  readonly name = "ProviderParseError" as const;
  readonly raw: string;
  constructor(provider: LLMProvider, message: string, raw: string) {
    super(message);
    this.provider = provider;
    this.raw = raw;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ProviderExhaustedError extends Error {
  readonly name = "ProviderExhaustedError" as const;
  readonly primary: LLMProvider;
  readonly fallback: LLMProvider;
  constructor(primary: LLMProvider, fallback: LLMProvider) {
    super(`Both providers exhausted: primary=${primary} fallback=${fallback}`);
    this.primary = primary;
    this.fallback = fallback;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type LlmCallContext = {
  userId: string;
  syncJobId?: string;
  operationType: string;
};
