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

export async function parseEmailTransaction(input: ParseInput): Promise<ParsedTransaction | null> {
  const { body, senderName, fallbackDate, apiKey } = input;

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
