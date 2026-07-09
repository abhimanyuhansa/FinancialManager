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
  "food", "transport", "shopping", "bills", "health",
  "investment", "income", "other",
];

const SYSTEM_PROMPT =
  "You are a financial transaction parser. Extract structured data from bank and merchant emails. " +
  "Always return valid JSON. If a field cannot be determined, use null. Never include explanations — only JSON.";

const USER_PROMPT = (body: string) =>
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
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: USER_PROMPT(body) }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    }
  );
  // Retry once on 503 (transient service unavailable) with a short wait
  if (res.status === 503 && attempt < 1) {
    await new Promise((r) => setTimeout(r, 2000));
    return callGemini(body, apiKey, attempt + 1);
  }
  return res;
}

const BODY_LIMIT = 1500;

export type BatchInput = {
  emailIndex: number;
  body: string;
  senderName: string;
  fallbackDate: string;
};

export type BatchResult = {
  emailIndex: number;
  outcome: "parsed" | "skipped_no_amount" | "skipped_gemini_null" | "failed_gemini_error";
  merchant?: string;
  amount?: number;
  currency?: string;
  date?: string;
  type?: "expense" | "income";
  category?: string;
  confidence?: number;
  needsReview?: boolean;
  bodyLengthRaw: number;
  bodyLengthSent: number;
  wasTruncated: boolean;
};

const BATCH_SYSTEM_PROMPT =
  "You are a financial transaction parser. Extract structured data from bank and merchant emails. " +
  "Return a JSON array — one object per email. Never include explanations — only JSON.";

function batchUserPrompt(
  items: Array<{ emailIndex: number; body: string; senderName: string; fallbackDate: string }>
): string {
  const emailsJson = JSON.stringify(
    items.map((i) => ({ emailIndex: i.emailIndex, senderName: i.senderName, fallbackDate: i.fallbackDate, body: i.body }))
  );
  return `Extract transactions from these emails. Return a JSON array with one object per email:
[
  {
    "emailIndex": number,
    "merchant": string | null,
    "amount": number | null,
    "currency": string | null,
    "date": string | null,
    "type": "expense" | "income" | null,
    "category": string | null,
    "confidence": number | null
  }
]

Valid categories: food, transport, shopping, bills, health, investment, income, other.
If an email contains no transaction, set amount to null.

Emails:
${emailsJson}`;
}

async function callGeminiBatch(prompt: string, apiKey: string): Promise<Response> {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
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

export async function parseEmailBatch(
  inputs: BatchInput[],
  apiKey: string
): Promise<BatchResult[]> {
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
    console.error(`[gemini] parseEmailBatch HTTP error: ${res.status}`);
    return prepared.map((p) => ({
      emailIndex: p.emailIndex,
      outcome: "failed_gemini_error" as const,
      bodyLengthRaw: p.bodyLengthRaw,
      bodyLengthSent: p.bodyLengthSent,
      wasTruncated: p.wasTruncated,
    }));
  }

  let parsed: Array<{
    emailIndex: number;
    merchant?: string | null;
    amount?: number | null;
    currency?: string | null;
    date?: string | null;
    type?: string | null;
    category?: string | null;
    confidence?: number | null;
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
      outcome: "failed_gemini_error" as const,
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
      return { emailIndex: p.emailIndex, outcome: "skipped_gemini_null" as const, ...meta };
    }

    const amount = typeof item.amount === "number" ? item.amount : null;
    if (!amount || amount <= 0) {
      return { emailIndex: p.emailIndex, outcome: "skipped_no_amount" as const, ...meta };
    }

    const confidence = typeof item.confidence === "number" ? item.confidence : 0;
    const merchant = item.merchant ?? p.senderName;
    const date = item.date ?? p.fallbackDate;
    const currency = item.currency ?? "INR";
    const type = item.type === "income" ? "income" : "expense";
    const category = item.category && VALID_CATEGORIES.includes(item.category)
      ? item.category
      : "other";

    return {
      emailIndex: p.emailIndex,
      outcome: "parsed" as const,
      merchant,
      amount,
      currency,
      date,
      type,
      category,
      confidence,
      needsReview: confidence < 0.7,
      ...meta,
    };
  });
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
