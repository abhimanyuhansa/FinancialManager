# Plan 9b: LLM Batching + ParseLog Instrumentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-email Gemini calls with 10-email batch calls; instrument every email through the pipeline with a ParseLog record; apply MerchantRule overrides to Gemini's category output.

**Architecture:** `src/lib/gemini.ts` gains a new `parseEmailBatch` export (old `parseEmailTransaction` stays for backward compat until Plan 9c removes it). `src/app/api/gmail/sync/chunk/route.ts` is updated to call the batch function, write ParseLog rows, and apply MerchantRule overrides. Body truncation limit changes from 4000 to 1500 chars per email.

**Prerequisite:** Plan 9a must be complete (ParseLog, MerchantRule models in DB).

**Tech Stack:** Next.js 16, Prisma 7, Gemini Flash API (batch prompt), TypeScript

---

## File Map

| File | Action |
|------|--------|
| `src/lib/gemini.ts` | Add `parseEmailBatch` function; keep `parseEmailTransaction` |
| `src/app/api/gmail/sync/chunk/route.ts` | Refactor to use `parseEmailBatch`, write ParseLog rows, apply MerchantRule overrides, reduce body truncation to 1500 chars |
| `tests/lib/gemini.test.ts` | Update/add tests for batch API |

---

## Task 1: Add `parseEmailBatch` to gemini.ts

**Files:**
- Modify: `src/lib/gemini.ts`

- [ ] **Step 1: Write the failing tests**

Create or update `tests/lib/gemini.test.ts`:

```typescript
import { parseEmailBatch } from "@/lib/gemini";

const MOCK_API_KEY = "test-key";

// Minimal fetch mock
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeGeminiResponse(items: unknown[]) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(items) }]
        }
      }]
    })
  };
}

describe("parseEmailBatch", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns parsed results for valid emails", async () => {
    mockFetch.mockResolvedValue(makeGeminiResponse([
      { emailIndex: 0, merchant: "Swiggy", amount: 450, currency: "INR", date: "2026-07-08", type: "expense", category: "food", confidence: 0.95 },
      { emailIndex: 1, merchant: "Zomato", amount: 320, currency: "INR", date: "2026-07-07", type: "expense", category: "food", confidence: 0.88 },
    ]));

    const inputs = [
      { emailIndex: 0, body: "Your Swiggy order of ₹450...", senderName: "Swiggy", fallbackDate: "2026-07-08" },
      { emailIndex: 1, body: "Your Zomato order of ₹320...", senderName: "Zomato", fallbackDate: "2026-07-07" },
    ];

    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ emailIndex: 0, merchant: "Swiggy", amount: 450, category: "food" });
    expect(results[1]).toMatchObject({ emailIndex: 1, merchant: "Zomato", amount: 320 });
  });

  it("marks null-amount items as skipped_no_amount without affecting other items", async () => {
    mockFetch.mockResolvedValue(makeGeminiResponse([
      { emailIndex: 0, merchant: null, amount: null, currency: "INR", date: "2026-07-08", type: "expense", category: null, confidence: null },
      { emailIndex: 1, merchant: "Amazon", amount: 999, currency: "INR", date: "2026-07-08", type: "expense", category: "shopping", confidence: 0.9 },
    ]));

    const inputs = [
      { emailIndex: 0, body: "Newsletter...", senderName: "newsletter@example.com", fallbackDate: "2026-07-08" },
      { emailIndex: 1, body: "Your Amazon order...", senderName: "Amazon", fallbackDate: "2026-07-08" },
    ];

    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ emailIndex: 0, outcome: "skipped_no_amount" });
    expect(results[1]).toMatchObject({ emailIndex: 1, merchant: "Amazon", amount: 999 });
  });

  it("returns skipped_gemini_null when Gemini omits an emailIndex from the response", async () => {
    // Only emailIndex 1 returned — emailIndex 0 was dropped
    mockFetch.mockResolvedValue(makeGeminiResponse([
      { emailIndex: 1, merchant: "Netflix", amount: 649, currency: "INR", date: "2026-07-08", type: "expense", category: "bills", confidence: 0.99 },
    ]));

    const inputs = [
      { emailIndex: 0, body: "Some email...", senderName: "unknown", fallbackDate: "2026-07-08" },
      { emailIndex: 1, body: "Netflix receipt...", senderName: "Netflix", fallbackDate: "2026-07-08" },
    ];

    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results).toHaveLength(2);
    expect(results.find(r => r.emailIndex === 0)).toMatchObject({ outcome: "skipped_gemini_null" });
    expect(results.find(r => r.emailIndex === 1)).toMatchObject({ merchant: "Netflix" });
  });

  it("returns failed_gemini_error when API call fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 });

    const inputs = [
      { emailIndex: 0, body: "Test...", senderName: "test", fallbackDate: "2026-07-08" },
    ];

    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ emailIndex: 0, outcome: "failed_gemini_error" });
  });

  it("truncates body to 1500 chars and records wasTruncated", async () => {
    const longBody = "x".repeat(3000);
    mockFetch.mockResolvedValue(makeGeminiResponse([
      { emailIndex: 0, merchant: "HDFC", amount: 5000, currency: "INR", date: "2026-07-08", type: "expense", category: "bills", confidence: 0.9 },
    ]));

    const inputs = [{ emailIndex: 0, body: longBody, senderName: "HDFC", fallbackDate: "2026-07-08" }];
    const results = await parseEmailBatch(inputs, MOCK_API_KEY);
    expect(results[0].wasTruncated).toBe(true);
    expect(results[0].bodyLengthRaw).toBe(3000);
    expect(results[0].bodyLengthSent).toBe(1500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/lib/gemini.test.ts --no-coverage
```

Expected: FAIL — `parseEmailBatch is not exported`

- [ ] **Step 3: Implement `parseEmailBatch` in gemini.ts**

Add the following to `src/lib/gemini.ts` (append after existing code, do not remove `parseEmailTransaction`):

```typescript
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

export async function parseEmailBatch(
  inputs: BatchInput[],
  apiKey: string
): Promise<BatchResult[]> {
  // Truncate each body and record metadata
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

  const res = await callGemini(batchUserPrompt(prepared), apiKey);

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/lib/gemini.test.ts --no-coverage
```

Expected: PASS — 5 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/lib/gemini.ts tests/lib/gemini.test.ts
git commit -m "feat(gemini): add parseEmailBatch with 10-email batching and body truncation"
```

---

## Task 2: Update chunk route to use batching + write ParseLog

**Files:**
- Modify: `src/app/api/gmail/sync/chunk/route.ts`

- [ ] **Step 1: Read the current chunk route**

Read `src/app/api/gmail/sync/chunk/route.ts` to understand the full current implementation before making changes.

- [ ] **Step 2: Update the chunk route**

Replace the content of `src/app/api/gmail/sync/chunk/route.ts` with:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { parseEmailBatch, BatchInput } from "@/lib/gemini";
import { upsertTransaction } from "@/lib/dedup";
import { matchesEmailFilter } from "@/lib/emailFilter";

const CHUNK_SIZE = 15;
const BATCH_SIZE = 10;
const BODY_LIMIT = 1500;

async function fetchFullMessage(
  accessToken: string,
  msgId: string
): Promise<{ body: string; senderName: string; senderDomain: string; receivedDate: string } | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;

  const msg = await res.json() as {
    id: string;
    internalDate?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    };
  };

  const headers = msg.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
  const senderRaw = get("From");
  const senderName = senderRaw.replace(/<[^>]+>/, "").trim() || senderRaw;
  const emailMatch = senderRaw.match(/<([^>]+)>/);
  const senderEmail = emailMatch ? emailMatch[1] : senderRaw;
  const senderDomain = senderEmail.includes("@") ? senderEmail.split("@")[1] : senderEmail;
  const receivedDate = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  let body = "";
  const parts = msg.payload?.parts ?? [];
  const plainPart = parts.find((p) => p.mimeType === "text/plain");
  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  const rawData = plainPart?.body?.data ?? htmlPart?.body?.data ?? msg.payload?.body?.data ?? "";
  if (rawData) {
    const decoded = Buffer.from(rawData, "base64url").toString("utf-8");
    body = decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return { body, senderName, senderDomain, receivedDate };
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { jobId } = (await req.json()) as { jobId: string };
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

  const job = await prisma.syncJob.findUnique({ where: { id: jobId, userId } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "running") {
    return NextResponse.json({ done: true, status: job.status });
  }

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";

  const allIds: string[] = job.messageIds ? JSON.parse(job.messageIds) : [];
  const slice = allIds.slice(job.processedEmails, job.processedEmails + CHUNK_SIZE);
  console.log(`[sync/chunk] jobId=${jobId} processed=${job.processedEmails}/${allIds.length} chunk=${slice.length}`);

  if (slice.length === 0) {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: { status: "complete", completedAt: new Date() },
    });
    return NextResponse.json({ done: true, processed: 0, newTransactions: 0 });
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token" }, { status: 401 });
  }

  // Fetch all messages in this chunk
  type FetchedEmail = {
    msgId: string;
    body: string;
    senderName: string;
    senderDomain: string;
    receivedDate: string;
    filtered: boolean;
  };

  const fetched: FetchedEmail[] = [];
  for (const msgId of slice) {
    const msg = await fetchFullMessage(accessToken, msgId);
    if (!msg) continue;

    const emailAddress = msg.senderName; // senderName may be display name; use senderDomain
    const isActive = await matchesEmailFilter(msg.senderDomain, emailAddress);
    fetched.push({
      msgId,
      body: msg.body,
      senderName: msg.senderName,
      senderDomain: msg.senderDomain,
      receivedDate: msg.receivedDate,
      filtered: !isActive,
    });
  }

  // Write ParseLog for filtered emails immediately
  const filteredLogs = fetched
    .filter((e) => e.filtered)
    .map((e) => ({
      userId,
      syncJobId: jobId,
      gmailMsgId: e.msgId,
      senderDomain: e.senderDomain,
      bodyLengthRaw: e.body.length,
      bodyLengthSent: Math.min(e.body.length, BODY_LIMIT),
      wasTruncated: e.body.length > BODY_LIMIT,
      batchSize: 1,
      outcome: "skipped_filter",
    }));
  if (filteredLogs.length > 0) {
    await prisma.parseLog.createMany({ data: filteredLogs });
  }

  // Process non-filtered emails in batches of BATCH_SIZE
  const toProcess = fetched.filter((e) => !e.filtered);
  let newTransactions = 0;
  let encryptedBlockedCount = 0;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const batchInputs: BatchInput[] = batch.map((e, idx) => ({
      emailIndex: idx,
      body: e.body,
      senderName: e.senderName,
      fallbackDate: e.receivedDate,
    }));

    const results = await parseEmailBatch(batchInputs, apiKey);

    for (const result of results) {
      const email = batch[result.emailIndex];
      if (!email) continue;

      const logBase = {
        userId,
        syncJobId: jobId,
        gmailMsgId: email.msgId,
        senderDomain: email.senderDomain,
        emailDate: new Date(email.receivedDate),
        bodyLengthRaw: result.bodyLengthRaw,
        bodyLengthSent: result.bodyLengthSent,
        wasTruncated: result.wasTruncated,
        batchSize: batch.length,
      };

      if (result.outcome !== "parsed") {
        await prisma.parseLog.create({
          data: {
            ...logBase,
            outcome: result.outcome,
          },
        });
        continue;
      }

      // Apply MerchantRule override
      let category = result.category!;
      const merchantKey = result.merchant!.toLowerCase().trim();
      const rule = await prisma.merchantRule.findUnique({
        where: { userId_merchantName: { userId, merchantName: merchantKey } },
      });
      if (rule) {
        console.log(`[sync/chunk] MerchantRule override: ${merchantKey} -> ${rule.category} (was ${category})`);
        category = rule.category;
      }

      // Upsert transaction
      const upsertResult = await upsertTransaction({
        userId,
        gmailMsgId: email.msgId,
        date: new Date(result.date!),
        merchant: result.merchant!,
        amount: result.amount!,
        type: result.type!,
        currency: result.currency!,
        category,
        source: "gmail",
        sourceRank: 3,
        confidence: result.confidence,
        needsReview: result.needsReview,
      });

      const outcome = upsertResult.action === "inserted" ? "inserted"
        : upsertResult.action === "upgraded" ? "upgraded"
        : "skipped_duplicate";

      if (outcome === "inserted") newTransactions++;

      await prisma.parseLog.create({
        data: {
          ...logBase,
          outcome,
          geminiConfidence: result.confidence,
          parsedMerchant: result.merchant,
          parsedAmount: result.amount,
          transactionId: upsertResult.id ?? undefined,
        },
      });
    }
  }

  const processed = job.processedEmails + slice.length;
  const isComplete = processed >= allIds.length;

  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      processedEmails: processed,
      newTransactions: { increment: newTransactions },
      encryptedBlockedCount: { increment: encryptedBlockedCount },
      ...(isComplete ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  console.log(`[sync/chunk] jobId=${jobId} done. new=${newTransactions} processed=${processed}/${allIds.length}`);
  return NextResponse.json({
    done: isComplete,
    processed: slice.length,
    newTransactions,
    totalProcessed: processed,
    total: allIds.length,
  });
}
```

**Note:** The `upsertTransaction` function in `src/lib/dedup.ts` needs to return `{ action: "inserted" | "upgraded" | "skipped", id?: string }`. Read `src/lib/dedup.ts` before making this change — if the return type is different, adapt accordingly.

- [ ] **Step 3: Check dedup.ts return type**

Read `src/lib/dedup.ts`. Verify what `upsertTransaction` returns. If it doesn't return `{ action, id }`, add that to the return value. The function should return:

```typescript
return { action: "inserted", id: newTx.id };
// or
return { action: "upgraded", id: existingTx.id };
// or
return { action: "skipped", id: existingTx.id };
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors. Fix any type errors before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/gmail/sync/chunk/route.ts src/lib/dedup.ts
git commit -m "feat(sync): use LLM batching, write ParseLog, apply MerchantRule overrides"
```

---

## Self-Check

- [x] `parseEmailBatch` takes array of `BatchInput`, returns array of `BatchResult` with `outcome` field
- [x] Bodies truncated to 1500 chars; `bodyLengthRaw`, `bodyLengthSent`, `wasTruncated` recorded
- [x] Items with `amount: null` → `skipped_no_amount` without affecting other batch items
- [x] Items missing from Gemini response → `skipped_gemini_null`
- [x] API errors → `failed_gemini_error` for all items in that batch
- [x] MerchantRule checked after Gemini, overrides category before DB write
- [x] ParseLog created for every email (filtered, skipped, or inserted)
- [x] Old `parseEmailTransaction` not removed (backward compat for Plan 9c transition)
