import { ParsedEmailItem, LLMProvider, ProviderParseError } from "./providers/types";

const VALID_CATEGORIES = [
  "food", "transport", "shopping", "entertainment", "utilities",
  "health", "finance", "travel", "groceries", "income", "other",
];

export function validateProviderResults(
  raw: ParsedEmailItem[],
  candidateCount: number,
  provider: LLMProvider
): ParsedEmailItem[] {
  if (raw.length !== candidateCount) {
    throw new ProviderParseError(
      provider,
      `Expected ${candidateCount} results, got ${raw.length}`,
      JSON.stringify(raw).slice(0, 200)
    );
  }

  const indices = new Set<number>();
  for (const item of raw) {
    if (item.emailIndex < 0 || item.emailIndex >= candidateCount) {
      throw new ProviderParseError(
        provider,
        `emailIndex ${item.emailIndex} out of range [0,${candidateCount})`,
        JSON.stringify(item).slice(0, 200)
      );
    }
    if (indices.has(item.emailIndex)) {
      throw new ProviderParseError(
        provider,
        `Duplicate emailIndex ${item.emailIndex}`,
        JSON.stringify(item).slice(0, 200)
      );
    }
    indices.add(item.emailIndex);
  }

  for (let i = 0; i < candidateCount; i++) {
    if (!indices.has(i)) {
      throw new ProviderParseError(
        provider,
        `Missing emailIndex ${i}`,
        JSON.stringify(raw).slice(0, 200)
      );
    }
  }

  return raw.map((item) => {
    if (!item.isTransaction || !item.transactions?.length) {
      return { ...item, isTransaction: false, transactions: [], outcome: "not_transaction" as const };
    }

    const validTxs = item.transactions.filter(
      (t) => typeof t.amount === "number" && t.amount > 0
    );

    if (validTxs.length === 0) {
      return { ...item, isTransaction: false, transactions: [], outcome: "insufficient_data" as const };
    }

    const sanitised = validTxs.map((t) => ({
      ...t,
      category: VALID_CATEGORIES.includes(t.category) ? t.category : "other",
      currency: t.currency ?? "INR",
      subCategory: t.subCategory ?? null,
      lineItems: t.lineItems ?? null,
    }));

    return { ...item, transactions: sanitised };
  });
}
