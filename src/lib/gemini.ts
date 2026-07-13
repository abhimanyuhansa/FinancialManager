export type ParsedTransaction = {
  merchant: string;
  amount: number;
  currency: string;
  date: string;
  type: "expense" | "income";
  category: string;
  confidence: number;
  needsReview: boolean;
};

type ParseInput = {
  body: string;
  senderName: string;
  fallbackDate: string;
  apiKey: string;
};

const VALID_CATEGORIES = [
  "food", "transport", "shopping", "entertainment", "utilities",
  "health", "finance", "travel", "groceries", "income", "other",
];

export type GeminiEmailResult = {
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
    lineItems: Array<{
      name: string;
      amount: number;
      subCategory?: string;
    }> | null;
  }>;
  outcome: "parsed" | "not_transaction" | "parse_failed" | "insufficient_data";
  bodyLengthRaw: number;
  bodyLengthSent: number;
  wasTruncated: boolean;
  errorDetail?: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
};

const GEMINI_MODEL = "gemini-2.0-flash-lite";

const BATCH_SYSTEM_PROMPT =
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
  "For each successfully parsed transaction email, also return subjectTemplate and bodyTemplate: copies of the subject and body with ALL dynamic values replaced by typed placeholders. Use: {{AMOUNT}}, {{DATE}}, {{MERCHANT}}, {{VPA}}, {{ACCOUNT}}, {{ORDER_ID}}, {{TRANSACTION_ID}}, {{CURRENCY}}. Replace every occurrence of each dynamic value, not just the first. Static text (bank name, fixed labels) stays unchanged.\n\n" +
  "Return a JSON array — one object per input email. Never include explanations — only JSON.";

function batchUserPrompt(
  items: Array<{ emailIndex: number; body: string; senderName: string; fallbackDate: string }>
): string {
  const emailsJson = JSON.stringify(
    items.map((i) => ({ emailIndex: i.emailIndex, senderName: i.senderName, fallbackDate: i.fallbackDate, body: i.body }))
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

async function callGeminiBatch(prompt: string, apiKey: string): Promise<Response> {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: BATCH_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    }
  );
}

export type BatchInput = {
  emailIndex: number;
  body: string;
  senderName: string;
  fallbackDate: string;
};

// Legacy type alias for backwards compatibility with tests
export type BatchResult = GeminiEmailResult;

const BODY_LIMIT = 1500;

export async function parseEmailBatch(
  inputs: BatchInput[],
  apiKey: string
): Promise<GeminiEmailResult[]> {
  const prepared = inputs.map((i) => {
    const bodyLengthRaw = i.body.length;
    const truncated = i.body.slice(0, BODY_LIMIT);
    return {
      emailIndex: i.emailIndex,
      body: truncated,
      senderName: i.senderName,
      fallbackDate: i.fallbackDate,
      bodyLengthRaw,
      bodyLengthSent: truncated.length,
      wasTruncated: bodyLengthRaw > BODY_LIMIT,
    };
  });

  const res = await callGeminiBatch(batchUserPrompt(prepared), apiKey);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`[gemini] parseEmailBatch HTTP error: ${res.status}`, errText.slice(0, 200));
    const errorDetail = `HTTP ${res.status}: ${errText.slice(0, 200)}`;
    return prepared.map((p) => ({
      emailIndex: p.emailIndex,
      isTransaction: false,
      transactions: [],
      outcome: "parse_failed" as const,
      bodyLengthRaw: p.bodyLengthRaw,
      bodyLengthSent: p.bodyLengthSent,
      wasTruncated: p.wasTruncated,
      errorDetail,
    }));
  }

  let parsed: Array<{
    emailIndex: number;
    isTransaction?: boolean;
    subjectTemplate?: string;
    bodyTemplate?: string;
    transactions?: Array<{
      merchant?: string | null;
      amount?: number | null;
      currency?: string | null;
      date?: string | null;
      type?: string | null;
      category?: string | null;
      subCategory?: string | null;
      confidence?: number | null;
      needsReview?: boolean | null;
      lineItems?: Array<{ name: string; amount: number; subCategory?: string }> | null;
    }>;
    outcome?: string | null;
  }> = [];

  try {
    const data = await res.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    console.error("[gemini] parseEmailBatch: failed to parse JSON response");
    return prepared.map((p) => ({
      emailIndex: p.emailIndex,
      isTransaction: false,
      transactions: [],
      outcome: "parse_failed" as const,
      bodyLengthRaw: p.bodyLengthRaw,
      bodyLengthSent: p.bodyLengthSent,
      wasTruncated: p.wasTruncated,
    }));
  }

  const parsedByIndex = new Map(parsed.map((item) => [item.emailIndex, item]));

  return prepared.map((p) => {
    const meta = {
      bodyLengthRaw: p.bodyLengthRaw,
      bodyLengthSent: p.bodyLengthSent,
      wasTruncated: p.wasTruncated,
    };

    const item = parsedByIndex.get(p.emailIndex);
    if (!item) {
      return {
        emailIndex: p.emailIndex,
        isTransaction: false,
        transactions: [],
        outcome: "parse_failed" as const,
        ...meta,
      };
    }

    if (!item.isTransaction || !item.transactions?.length) {
      return {
        emailIndex: p.emailIndex,
        isTransaction: false,
        transactions: [],
        outcome: "not_transaction" as const,
        ...meta,
      };
    }

    const transactions = item.transactions
      .filter((t) => typeof t.amount === "number" && (t.amount ?? 0) > 0)
      .map((t) => {
        const confidence = typeof t.confidence === "number" ? t.confidence : 0;
        const category = t.category && VALID_CATEGORIES.includes(t.category) ? t.category : "other";
        return {
          merchant: t.merchant ?? p.senderName,
          amount: t.amount!,
          currency: t.currency ?? "INR",
          date: t.date ?? p.fallbackDate,
          type: (t.type === "income" ? "income" : "expense") as "expense" | "income",
          category,
          subCategory: t.subCategory ?? null,
          confidence,
          needsReview: t.needsReview ?? confidence < 0.7,
          lineItems: t.lineItems ?? null,
        };
      });

    if (transactions.length === 0) {
      return {
        emailIndex: p.emailIndex,
        isTransaction: false,
        transactions: [],
        outcome: "insufficient_data" as const,
        ...meta,
      };
    }

    return {
      emailIndex: p.emailIndex,
      isTransaction: true,
      transactions,
      outcome: "parsed" as const,
      ...meta,
      ...(item.subjectTemplate ? { subjectTemplate: item.subjectTemplate } : {}),
      ...(item.bodyTemplate ? { bodyTemplate: item.bodyTemplate } : {}),
    };
  });
}

const LEGACY_SYSTEM_PROMPT =
  "You are a financial transaction parser. Extract structured data from bank and merchant emails. " +
  "Always return valid JSON. If a field cannot be determined, use null. Never include explanations — only JSON.";

const LEGACY_USER_PROMPT = (body: string) =>
  `Extract the transaction from this email. Return JSON with these exact fields:
{
  "merchant": string,
  "amount": number,
  "currency": string,
  "date": string,
  "type": "expense"|"income",
  "category": string,
  "confidence": number
}

Email:
${body}`;

async function callGemini(body: string, apiKey: string, attempt = 0): Promise<Response> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: LEGACY_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: LEGACY_USER_PROMPT(body) }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    }
  );
  if (res.status === 503 && attempt < 1) {
    await new Promise((r) => setTimeout(r, 2000));
    return callGemini(body, apiKey, attempt + 1);
  }
  return res;
}

export async function parseEmailTransaction(input: ParseInput): Promise<ParsedTransaction | null> {
  const { body, senderName, fallbackDate, apiKey } = input;

  const res = await callGemini(body, apiKey);

  if (!res.ok) {
    console.error(`[gemini] parseEmailTransaction HTTP error: ${res.status} for sender="${senderName}"`);
    return null;
  }

  try {
    const data = await res.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(clean) as {
      merchant?: string | null;
      amount?: number | null;
      currency?: string | null;
      date?: string | null;
      type?: string | null;
      category?: string | null;
      confidence?: number | null;
    };

    const amount = typeof parsed.amount === "number" ? parsed.amount : null;
    if (!amount || amount <= 0) {
      console.log(`[gemini] Skipping email from "${senderName}": amount=${amount} (invalid)`);
      return null;
    }

    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const merchant = parsed.merchant ?? senderName;
    const date = parsed.date ?? fallbackDate;
    const currency = parsed.currency ?? "INR";
    const type = parsed.type === "income" ? "income" : "expense";
    const category = parsed.category && VALID_CATEGORIES.includes(parsed.category)
      ? parsed.category
      : "other";

    console.log(`[gemini] Parsed: merchant="${merchant}" amount=${amount} type=${type} category=${category} confidence=${confidence} needsReview=${confidence < 0.7}`);

    return {
      merchant,
      amount,
      currency,
      date,
      type,
      category,
      confidence,
      needsReview: confidence < 0.7,
    };
  } catch {
    console.error(`[gemini] Failed to parse response for sender="${senderName}"`);
    return null;
  }
}
