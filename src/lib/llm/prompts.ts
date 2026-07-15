export const SCHEMA_VERSION = "v1";

const CHARS_PER_TOKEN = 4;

const EMAIL_ITEM_PROPERTIES = {
  merchant: { type: "string" },
  amount: { type: "number" },
  currency: { type: "string" },
  date: { type: "string" },
  type: { type: "string", enum: ["expense", "income"] },
  category: { type: "string" },
  confidence: { type: "number" },
  needsReview: { type: "boolean" },
} as const;

const EMAIL_ITEM_REQUIRED = [
  "merchant", "amount", "currency", "date", "type", "category",
  "subCategory", "confidence", "needsReview", "lineItems",
] as const;

const EMAIL_RESULT_REQUIRED = ["emailIndex", "isTransaction", "transactions", "outcome"] as const;
const OPENAI_EMAIL_RESULT_REQUIRED = ["emailIndex", "isTransaction", "transactions", "outcome", "subjectTemplate", "bodyTemplate"] as const;

// Gemini responseSchema — uses nullable:true (proto-based, no union types)
export const EMAIL_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      emailIndex: { type: "integer" },
      isTransaction: { type: "boolean" },
      transactions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ...EMAIL_ITEM_PROPERTIES,
            subCategory: { type: "string", nullable: true },
            lineItems: {
              type: "array",
              nullable: true,
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  amount: { type: "number" },
                  subCategory: { type: "string" },
                },
              },
            },
          },
          required: EMAIL_ITEM_REQUIRED,
        },
      },
      outcome: { type: "string", enum: ["parsed", "not_transaction", "parse_failed", "insufficient_data"] },
      subjectTemplate: { type: "string" },
      bodyTemplate: { type: "string" },
    },
    required: EMAIL_RESULT_REQUIRED,
  },
} as const;

// OpenAI json_schema — generated per batch so minItems/maxItems can enforce exact count
export function buildOpenAIEmailJsonSchema(candidateCount: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        minItems: candidateCount,
        maxItems: candidateCount,
        items: {
          type: "object",
          properties: {
            emailIndex: { type: "integer" },
            isTransaction: { type: "boolean" },
            transactions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ...EMAIL_ITEM_PROPERTIES,
                  subCategory: { anyOf: [{ type: "string" }, { type: "null" }] },
                  lineItems: {
                    anyOf: [
                      {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            amount: { type: "number" },
                            subCategory: { type: "string" },
                          },
                          required: ["name", "amount", "subCategory"],
                          additionalProperties: false,
                        },
                      },
                      { type: "null" },
                    ],
                  },
                },
                required: EMAIL_ITEM_REQUIRED,
                additionalProperties: false,
              },
            },
            outcome: { type: "string", enum: ["parsed", "not_transaction", "parse_failed", "insufficient_data"] },
            subjectTemplate: { type: "string" },
            bodyTemplate: { type: "string" },
          },
          required: OPENAI_EMAIL_RESULT_REQUIRED,
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
}

export const BATCH_SYSTEM_PROMPT =
  "You are a financial transaction parser. For each email, decide if it is a financial transaction email, then extract ALL transactions.\n\n" +
  "TRANSACTION emails include: payment confirmations, debit/credit alerts, invoices, receipts, subscription charges, EMI notices, order confirmations with amounts, bank statements, dividend notices, salary credits.\n\n" +
  "NOT TRANSACTION emails include: newsletters, marketing, job alerts, social notifications, OTP without amount, verification emails, promotional discount offers without an actual charge.\n\n" +
  "For each transaction extract:\n" +
  "- merchant: the business paid/received from — NOT the sending bank. E.g. for 'Rs.341 debited to Zepto via Amazon Pay', merchant = 'Zepto'\n" +
  "- amount: positive number\n" +
  "- currency: 'INR' by default\n" +
  "- date: from email content (YYYY-MM-DD); use fallbackDate only if no date in body\n" +
  "- type: 'expense' (money out) or 'income' (money in — salary, refund, dividend)\n" +
  "- category: one of: food, transport, shopping, entertainment, utilities, health, finance, travel, groceries, income, other\n" +
  "- subCategory: specific sub-type (e.g. 'restaurants', 'cab', 'streaming', 'electricity', 'salary', 'dividend') — null if uncertain\n" +
  "- confidence: 0.0–1.0\n" +
  "- needsReview: true if amount or merchant is ambiguous\n" +
  "- lineItems: array ONLY when email explicitly itemises charges (grocery list, restaurant bill). null otherwise.\n\n" +
  "For each successfully parsed transaction email, also return subjectTemplate and bodyTemplate: copies of the subject and body with ALL dynamic values replaced by typed placeholders. Use: {{AMOUNT}}, {{DATE}}, {{MERCHANT}}, {{VPA}}, {{ACCOUNT}}, {{ORDER_ID}}, {{TRANSACTION_ID}}, {{CURRENCY}}. Replace every occurrence of each dynamic value. Static text (bank name, fixed labels) stays unchanged.\n\n" +
  "Return a JSON array — one object per input email. Never include explanations — only JSON.";

export type EmailInput = { emailIndex: number; body: string; senderName: string; fallbackDate: string };

export function buildBatchUserPrompt(items: EmailInput[]): string {
  const emailsJson = JSON.stringify(
    items.map((i) => ({
      emailIndex: i.emailIndex,
      senderName: i.senderName,
      fallbackDate: i.fallbackDate,
      body: i.body,
    }))
  );
  return `Parse these emails. Return a JSON array — one object per email matching this schema exactly:
[
  {
    "emailIndex": number,
    "isTransaction": boolean,
    "transactions": [
      {
        "merchant": string,
        "amount": number,
        "currency": string,
        "date": string,
        "type": "expense" | "income",
        "category": string,
        "subCategory": string | null,
        "confidence": number,
        "needsReview": boolean,
        "lineItems": [{ "name": string, "amount": number, "subCategory": string }] | null
      }
    ],
    "outcome": "parsed" | "not_transaction" | "parse_failed" | "insufficient_data"
  }
]

If isTransaction is false, set transactions to [] and outcome to "not_transaction".

Emails:
${emailsJson}`;
}

export const STATEMENT_SYSTEM_PROMPT =
  "This is a bank or credit card statement. Extract every transaction listed. " +
  "Return a JSON array where each item has: " +
  '{"date": string, "merchant": string, "amount": number, "type": "expense"|"debit"|"credit"|"income"}. ' +
  "Return only the array. No explanations.";

export function buildStatementUserPrompt(body: string): string {
  return `Statement:\n${body}`;
}

export function estimateInputTokens(items: EmailInput[]): number {
  const promptText = BATCH_SYSTEM_PROMPT + buildBatchUserPrompt(items);
  return Math.ceil(promptText.length / CHARS_PER_TOKEN);
}

export function estimateOutputTokens(candidateCount: number): number {
  return candidateCount * 150;
}
