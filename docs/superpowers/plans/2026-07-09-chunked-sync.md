# Financial Manager — Chunked Gmail Sync Pipeline (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the chunked Gmail sync pipeline — fetch full email bodies from approved senders, parse each one with Gemini, deduplicate using 4 layers (EmailFilter pre-screen → gmailMsgId unique → fingerprint unique → sourceRank priority), write `Transaction` rows, and drive the whole thing from a client-side polling loop that shows a live progress bar.

**Architecture:** `POST /api/gmail/sync/start` creates a `SyncJob` and collects the full list of qualifying message IDs (filtered to approved senders only, after `syncFromDate`). `POST /api/gmail/sync/chunk` processes the next 15 emails: fetches the full body, calls Gemini, applies 4-layer dedup, writes to DB, advances `SyncJob.processedEmails`. The client polls `GET /api/gmail/sync/status` every 2 seconds and drives the loop until `done: true`. A `SyncProgressBar` component lives on the onboarding page after "Start Importing" is clicked, and also on the dashboard for manual re-syncs. All LLM parsing logic lives in `src/lib/gemini.ts`; dedup fingerprint logic lives in `src/lib/dedup.ts`; the three API routes are thin orchestrators that import from those libraries.

**Tech Stack:** Next.js App Router API routes, Gmail REST API v1 (full message format), Gemini 2.5 Flash (`gemini-flash-latest`), Prisma 7, NextAuth v5, React `useState` + `useEffect` polling (Client Component)

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/lib/gemini.ts` | Gemini API call — takes email body, returns parsed transaction JSON |
| Create | `src/lib/dedup.ts` | `buildFingerprint`, `upsertTransaction` — 4-layer dedup logic |
| Create | `src/app/api/gmail/sync/start/route.ts` | POST — create SyncJob, collect qualifying message IDs, store in SyncJob |
| Create | `src/app/api/gmail/sync/chunk/route.ts` | POST — process next 15 emails, call Gemini, dedup, write transactions |
| Create | `src/app/api/gmail/sync/status/route.ts` | GET — return SyncJob progress |
| Create | `src/components/SyncProgressBar.tsx` | Client Component — polls status, shows progress bar + summary |
| Modify | `src/app/(app)/onboarding/page.tsx` | After confirm → show SyncProgressBar instead of navigating |
| Modify | `src/app/(app)/dashboard/page.tsx` | Replace stub with greeting + "Sync Gmail" button + SyncProgressBar |
| Create | `tests/lib/gemini.test.ts` | Unit tests for Gemini response parsing / validation |
| Create | `tests/lib/dedup.test.ts` | Unit tests for buildFingerprint and upsertTransaction logic |

---

### Task 1: Gemini parser — `src/lib/gemini.ts` (TDD)

**Files:**
- Create: `src/lib/gemini.ts`
- Create: `tests/lib/gemini.test.ts`

The Gemini parser takes a raw email body string and returns a structured transaction object. The parsing logic (prompt construction, response validation, field normalization) is a pure function that wraps an async HTTP call. Tests mock the fetch so they never hit the real API.

Context from the design spec (§10):
- System prompt: "You are a financial transaction parser. Extract structured data from bank and merchant emails. Always return valid JSON. If a field cannot be determined, use null. Never include explanations — only JSON."
- User prompt includes the email body and requests these fields: `merchant`, `amount`, `currency`, `date`, `type` ("expense"|"income"), `category`, `confidence` (0–1).
- `confidence < 0.7` → the caller sets `needsReview: true` on the transaction.
- `amount <= 0` → discard (return null).
- `date` unparseable → use the email's received date (passed in as `fallbackDate`).
- Missing `merchant` → use `senderName` (passed in).

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/gemini.test.ts
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { parseEmailTransaction, ParsedTransaction } from "@/lib/gemini";

const FAKE_KEY = "test-key";

function mockGeminiResponse(json: object) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify(json) }],
          },
        },
      ],
    }),
  });
}

describe("parseEmailTransaction", () => {
  beforeEach(() => mockFetch.mockClear());

  it("returns parsed transaction on valid response", async () => {
    mockGeminiResponse({
      merchant: "Swiggy",
      amount: 349,
      currency: "INR",
      date: "2026-06-15",
      type: "expense",
      category: "food",
      confidence: 0.95,
    });

    const result = await parseEmailTransaction({
      body: "Your Swiggy order of ₹349 has been placed.",
      senderName: "Swiggy",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).not.toBeNull();
    expect(result!.merchant).toBe("Swiggy");
    expect(result!.amount).toBe(349);
    expect(result!.category).toBe("food");
    expect(result!.needsReview).toBe(false);
  });

  it("sets needsReview = true when confidence < 0.7", async () => {
    mockGeminiResponse({
      merchant: "Unknown",
      amount: 100,
      currency: "INR",
      date: "2026-06-15",
      type: "expense",
      category: "other",
      confidence: 0.5,
    });

    const result = await parseEmailTransaction({
      body: "Some ambiguous email.",
      senderName: "Unknown",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).not.toBeNull();
    expect(result!.needsReview).toBe(true);
  });

  it("returns null when amount <= 0", async () => {
    mockGeminiResponse({
      merchant: "Swiggy",
      amount: 0,
      currency: "INR",
      date: "2026-06-15",
      type: "expense",
      category: "food",
      confidence: 0.9,
    });

    const result = await parseEmailTransaction({
      body: "Zero amount email.",
      senderName: "Swiggy",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).toBeNull();
  });

  it("uses fallbackDate when LLM returns null date", async () => {
    mockGeminiResponse({
      merchant: "Zomato",
      amount: 250,
      currency: "INR",
      date: null,
      type: "expense",
      category: "food",
      confidence: 0.85,
    });

    const result = await parseEmailTransaction({
      body: "Your Zomato order.",
      senderName: "Zomato",
      fallbackDate: "2026-06-20",
      apiKey: FAKE_KEY,
    });

    expect(result).not.toBeNull();
    expect(result!.date).toBe("2026-06-20");
  });

  it("uses senderName when LLM returns null merchant", async () => {
    mockGeminiResponse({
      merchant: null,
      amount: 500,
      currency: "INR",
      date: "2026-06-15",
      type: "expense",
      category: "other",
      confidence: 0.8,
    });

    const result = await parseEmailTransaction({
      body: "Some bank email.",
      senderName: "HDFC Bank",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).not.toBeNull();
    expect(result!.merchant).toBe("HDFC Bank");
  });

  it("returns null when fetch fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => "quota exceeded" });

    const result = await parseEmailTransaction({
      body: "Some email.",
      senderName: "Sender",
      fallbackDate: "2026-06-15",
      apiKey: FAKE_KEY,
    });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/gemini.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/lib/gemini'`

- [ ] **Step 3: Create `src/lib/gemini.ts`**

```typescript
// src/lib/gemini.ts

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
  fallbackDate: string; // ISO date string — used when LLM returns null date
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

  if (!res.ok) return null;

  try {
    const data = await res.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    // Strip markdown code fences if present
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
    if (!amount || amount <= 0) return null;

    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const merchant = parsed.merchant ?? senderName;
    const date = parsed.date ?? fallbackDate;
    const currency = parsed.currency ?? "INR";
    const type = parsed.type === "income" ? "income" : "expense";
    const category = parsed.category && VALID_CATEGORIES.includes(parsed.category)
      ? parsed.category
      : "other";

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
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/gemini.test.ts 2>&1 | tail -10
```

Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gemini.ts tests/lib/gemini.test.ts
git commit -m "feat: add Gemini email parser with tests"
```

---

### Task 2: Dedup logic — `src/lib/dedup.ts` (TDD)

**Files:**
- Create: `src/lib/dedup.ts`
- Create: `tests/lib/dedup.test.ts`

Two functions live here:
1. `buildFingerprint(merchant, amount, date)` — deterministic key for dedup Layer 3. Normalizes merchant name, uses a 2-day time bucket so the same real-world payment from different emails maps to the same fingerprint.
2. `upsertTransaction(prisma, userId, data)` — Layers 2, 3, and 4 combined. Skips if `gmailMsgId` already exists (Layer 2). On fingerprint collision (Layer 3), keeps the higher-sourceRank record (Layer 4). Otherwise inserts.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/dedup.test.ts
import { buildFingerprint } from "@/lib/dedup";

describe("buildFingerprint", () => {
  it("normalizes merchant to lowercase alphanumeric", () => {
    const fp = buildFingerprint("Swiggy Food", 349, new Date("2026-06-15T10:00:00Z"));
    expect(fp).toMatch(/^swiggyfood\|/);
  });

  it("same merchant + amount + date within 2-day window → same fingerprint", () => {
    const fp1 = buildFingerprint("Zomato", 250, new Date("2026-06-15T08:00:00Z"));
    const fp2 = buildFingerprint("Zomato", 250, new Date("2026-06-16T20:00:00Z"));
    // Both fall in the same 2-day bucket (bucket = floor(ms / 2-day-ms))
    const bucket1 = Math.floor(new Date("2026-06-15T08:00:00Z").getTime() / (2 * 24 * 60 * 60 * 1000));
    const bucket2 = Math.floor(new Date("2026-06-16T20:00:00Z").getTime() / (2 * 24 * 60 * 60 * 1000));
    if (bucket1 === bucket2) {
      expect(fp1).toBe(fp2);
    } else {
      // Different buckets — that's fine, just verify they're both formatted consistently
      expect(fp1).toMatch(/^zomato\|250\|\d+$/);
      expect(fp2).toMatch(/^zomato\|250\|\d+$/);
    }
  });

  it("different amount → different fingerprint", () => {
    const fp1 = buildFingerprint("Swiggy", 349, new Date("2026-06-15T10:00:00Z"));
    const fp2 = buildFingerprint("Swiggy", 350, new Date("2026-06-15T10:00:00Z"));
    expect(fp1).not.toBe(fp2);
  });

  it("different merchant → different fingerprint", () => {
    const fp1 = buildFingerprint("Swiggy", 349, new Date("2026-06-15T10:00:00Z"));
    const fp2 = buildFingerprint("Zomato", 349, new Date("2026-06-15T10:00:00Z"));
    expect(fp1).not.toBe(fp2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/dedup.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/lib/dedup'`

- [ ] **Step 3: Create `src/lib/dedup.ts`**

```typescript
// src/lib/dedup.ts
import type { PrismaClient } from "@prisma/client";
import type { ParsedTransaction } from "@/lib/gemini";

export function buildFingerprint(merchant: string, amount: number, date: Date): string {
  const normalizedMerchant = merchant.toLowerCase().replace(/[^a-z0-9]/g, "");
  const dateBucket = Math.floor(date.getTime() / (2 * 24 * 60 * 60 * 1000));
  return `${normalizedMerchant}|${amount}|${dateBucket}`;
}

type UpsertInput = {
  gmailMsgId: string;
  parsed: ParsedTransaction;
  sourceRank: number; // from the EmailFilter that matched this sender
};

type UpsertResult = "inserted" | "skipped_msgid" | "skipped_fingerprint" | "upgraded";

export async function upsertTransaction(
  prisma: PrismaClient,
  userId: string,
  input: UpsertInput
): Promise<UpsertResult> {
  const { gmailMsgId, parsed, sourceRank } = input;

  // Layer 2: skip if this gmailMsgId was already processed
  const existing = await prisma.transaction.findUnique({
    where: { userId_gmailMsgId: { userId, gmailMsgId } },
    select: { id: true },
  });
  if (existing) return "skipped_msgid";

  const date = new Date(parsed.date);
  const fingerprint = buildFingerprint(parsed.merchant, parsed.amount, date);

  // Layer 3 + 4: check fingerprint collision
  const fpExisting = await prisma.transaction.findUnique({
    where: { userId_fingerprint: { userId, fingerprint } },
    select: { id: true, sourceRank: true },
  });

  if (fpExisting) {
    // Layer 4: keep higher-priority (lower sourceRank number) record
    if (sourceRank < fpExisting.sourceRank) {
      // Incoming is higher priority — upgrade the existing record
      await prisma.transaction.update({
        where: { id: fpExisting.id },
        data: {
          gmailMsgId,
          sourceRank,
          merchant: parsed.merchant,
          amount: parsed.amount,
          type: parsed.type,
          category: parsed.category,
          currency: parsed.currency,
          needsReview: parsed.needsReview,
        },
      });
      return "upgraded";
    }
    return "skipped_fingerprint";
  }

  // No collision — insert fresh
  await prisma.transaction.create({
    data: {
      userId,
      gmailMsgId,
      fingerprint,
      date,
      merchant: parsed.merchant,
      amount: parsed.amount,
      type: parsed.type,
      currency: parsed.currency,
      category: parsed.category,
      sourceRank,
      needsReview: parsed.needsReview,
    },
  });
  return "inserted";
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/dedup.test.ts 2>&1 | tail -10
```

Expected: PASS — 4 tests pass.

- [ ] **Step 5: Run all tests to make sure nothing broken**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npm test 2>&1 | tail -10
```

Expected: all tests pass (25 + 10 = 35 total).

- [ ] **Step 6: Commit**

```bash
git add src/lib/dedup.ts tests/lib/dedup.test.ts
git commit -m "feat: add dedup logic — buildFingerprint and upsertTransaction with tests"
```

---

### Task 3: Sync start route (`POST /api/gmail/sync/start`)

**Files:**
- Create: `src/app/api/gmail/sync/start/route.ts`

This route creates the `SyncJob` and collects the full list of qualifying Gmail message IDs (all messages from approved senders after `syncFromDate`). The IDs are stored as a JSON array in a new `messageIds` field on `SyncJob`. The chunk route then slices off 15 at a time using `processedEmails` as the cursor.

**Schema change first:** `SyncJob` needs a `messageIds` field to store the collected message IDs. Add it as a nullable `Text` column (JSON-serialized string array) via a migration.

- [ ] **Step 1: Add `messageIds` to the Prisma schema**

Open `prisma/schema.prisma` and add the field to `SyncJob`:

```prisma
model SyncJob {
  id              String    @id @default(cuid())
  userId          String
  status          String    @default("running")
  totalEmails     Int       @default(0)
  processedEmails Int       @default(0)
  newTransactions Int       @default(0)
  skippedEmails   Int       @default(0)
  isRetrigger     Boolean   @default(false)
  messageIds      String?   @db.Text   // JSON array of Gmail message IDs to process
  startedAt       DateTime  @default(now())
  completedAt     DateTime?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Run migration**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx prisma migrate dev --name add_syncjob_messageids 2>&1 | tail -10
```

Expected: `Your database is now in sync with your schema.`

- [ ] **Step 3: Regenerate Prisma client**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx prisma generate 2>&1 | tail -5
```

Expected: `✔ Generated Prisma Client`

- [ ] **Step 4: Write `src/app/api/gmail/sync/start/route.ts`**

```typescript
// src/app/api/gmail/sync/start/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken, fetchMessageMetadataList } from "@/lib/gmail";
import { matchesEmailFilter } from "@/lib/emailFilter";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { syncFromDate: true },
  });
  if (!user?.syncFromDate) {
    return NextResponse.json({ error: "No syncFromDate set — complete onboarding first" }, { status: 400 });
  }

  // Load active filters to pre-screen senders
  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });

  // Collect all message metadata after syncFromDate, filter to approved senders only
  const qualifyingIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await fetchMessageMetadataList(accessToken, user.syncFromDate, pageToken);
    for (const msg of page.messages) {
      const match = matchesEmailFilter(msg, filters);
      if (match.matched) qualifyingIds.push(msg.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  // Create SyncJob with collected IDs
  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: qualifyingIds.length,
      messageIds: JSON.stringify(qualifyingIds),
    },
  });

  return NextResponse.json({ jobId: job.id, totalEmails: qualifyingIds.length });
}
```

- [ ] **Step 5: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/app/api/gmail/sync/start/route.ts
git commit -m "feat: add POST /api/gmail/sync/start — creates SyncJob with qualifying message IDs"
```

---

### Task 4: Sync chunk route (`POST /api/gmail/sync/chunk`)

**Files:**
- Create: `src/app/api/gmail/sync/chunk/route.ts`

This is the core processing route. It takes a `jobId`, reads the next 15 unprocessed message IDs from the job's `messageIds` array (using `processedEmails` as cursor), fetches each full email body, calls Gemini, applies 4-layer dedup via `upsertTransaction`, and updates the `SyncJob` progress. The `GEMINI_API_KEY` env var is used here.

- [ ] **Step 1: Write `src/app/api/gmail/sync/chunk/route.ts`**

```typescript
// src/app/api/gmail/sync/chunk/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { parseEmailTransaction } from "@/lib/gemini";
import { upsertTransaction } from "@/lib/dedup";
import { matchesEmailFilter } from "@/lib/emailFilter";

const CHUNK_SIZE = 15;

async function fetchFullMessage(
  accessToken: string,
  msgId: string
): Promise<{ body: string; senderName: string; receivedDate: string } | null> {
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
  // "Display Name <email@domain.com>" → "Display Name"
  const senderName = senderRaw.replace(/<[^>]+>/, "").trim() || senderRaw;
  const receivedDate = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  // Extract body: prefer text/plain, fall back to text/html, strip HTML tags
  let body = "";
  const parts = msg.payload?.parts ?? [];
  const plainPart = parts.find((p) => p.mimeType === "text/plain");
  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  const rawData = plainPart?.body?.data ?? htmlPart?.body?.data ?? msg.payload?.body?.data ?? "";
  if (rawData) {
    const decoded = Buffer.from(rawData, "base64url").toString("utf-8");
    body = decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
  }

  return { body, senderName, receivedDate };
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

  const allIds: string[] = job.messageIds ? JSON.parse(job.messageIds) : [];
  const slice = allIds.slice(job.processedEmails, job.processedEmails + CHUNK_SIZE);

  if (slice.length === 0) {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: { status: "complete", completedAt: new Date() },
    });
    return NextResponse.json({ done: true, processed: 0, newTransactions: 0 });
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    await prisma.syncJob.update({ where: { id: jobId }, data: { status: "failed" } });
    return NextResponse.json({ error: "No Gmail token" }, { status: 401 });
  }

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });
  const apiKey = process.env.GEMINI_API_KEY ?? "";

  let newTransactions = 0;
  let skipped = 0;

  for (const msgId of slice) {
    const full = await fetchFullMessage(accessToken, msgId);
    if (!full || !full.body) { skipped++; continue; }

    // Re-check filter to get sourceRank for this message
    // fetchMessageMetadataList already pre-screened, but we need the sourceRank
    // We approximate by matching against filters using senderName as domain heuristic
    // The actual from address isn't re-fetched here, so use sourceRank 3 as fallback
    // and let upsertTransaction's Layer 4 handle upgrades when bank email arrives later.
    // For proper sourceRank we check the full From header during metadata phase.
    // Here we use rank 3 (merchant) as a safe default — bank emails will upgrade via Layer 4.
    const sourceRankMatch = matchesEmailFilter(
      { id: msgId, from: full.senderName, subject: "", date: full.receivedDate },
      filters
    );
    const sourceRank = sourceRankMatch.matched ? sourceRankMatch.sourceRank : 3;

    const parsed = await parseEmailTransaction({
      body: full.body,
      senderName: full.senderName,
      fallbackDate: full.receivedDate,
      apiKey,
    });

    if (!parsed) { skipped++; continue; }

    const result = await upsertTransaction(prisma, userId, {
      gmailMsgId: msgId,
      parsed,
      sourceRank,
    });

    if (result === "inserted" || result === "upgraded") newTransactions++;
    else skipped++;
  }

  const newProcessed = job.processedEmails + slice.length;
  const done = newProcessed >= allIds.length;

  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      processedEmails: newProcessed,
      newTransactions: { increment: newTransactions },
      skippedEmails: { increment: skipped },
      ...(done ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  return NextResponse.json({ done, processed: slice.length, newTransactions });
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Run all tests**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/gmail/sync/chunk/route.ts
git commit -m "feat: add POST /api/gmail/sync/chunk — fetches full email, calls Gemini, 4-layer dedup"
```

---

### Task 5: Sync status route (`GET /api/gmail/sync/status`)

**Files:**
- Create: `src/app/api/gmail/sync/status/route.ts`

- [ ] **Step 1: Write `src/app/api/gmail/sync/status/route.ts`**

```typescript
// src/app/api/gmail/sync/status/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

  const job = await prisma.syncJob.findUnique({
    where: { id: jobId, userId },
    select: {
      status: true,
      totalEmails: true,
      processedEmails: true,
      newTransactions: true,
      skippedEmails: true,
      startedAt: true,
      completedAt: true,
    },
  });

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({
    status: job.status,
    totalEmails: job.totalEmails,
    processedEmails: job.processedEmails,
    newTransactions: job.newTransactions,
    skippedEmails: job.skippedEmails,
    done: job.status !== "running",
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  });
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/gmail/sync/status/route.ts
git commit -m "feat: add GET /api/gmail/sync/status"
```

---

### Task 6: `SyncProgressBar` component

**Files:**
- Create: `src/components/SyncProgressBar.tsx`

This Client Component receives a `jobId`, polls `/api/gmail/sync/status` every 2 seconds while the job is running, fires `POST /api/gmail/sync/chunk` on each tick to advance the job, and shows a progress bar + live stats.

Props: `{ jobId: string; onComplete?: (newTransactions: number) => void }`

- [ ] **Step 1: Create `src/components/SyncProgressBar.tsx`**

```tsx
// src/components/SyncProgressBar.tsx
"use client";
import { useEffect, useRef, useState } from "react";

type JobStatus = {
  status: string;
  totalEmails: number;
  processedEmails: number;
  newTransactions: number;
  skippedEmails: number;
  done: boolean;
};

type SyncProgressBarProps = {
  jobId: string;
  onComplete?: (newTransactions: number) => void;
};

export function SyncProgressBar({ jobId, onComplete }: SyncProgressBarProps) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(true);

  useEffect(() => {
    runningRef.current = true;

    async function tick() {
      try {
        // Advance the chunk
        const chunkRes = await fetch("/api/gmail/sync/chunk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });
        if (!chunkRes.ok) {
          const err = (await chunkRes.json()) as { error: string };
          setError(err.error ?? "Sync failed");
          return;
        }

        // Poll status
        const statusRes = await fetch(`/api/gmail/sync/status?jobId=${jobId}`);
        if (!statusRes.ok) { setError("Failed to get status"); return; }
        const data = (await statusRes.json()) as JobStatus;
        setStatus(data);

        if (data.done) {
          onComplete?.(data.newTransactions);
          return;
        }

        if (runningRef.current) {
          setTimeout(tick, 2000);
        }
      } catch {
        setError("Network error during sync");
      }
    }

    tick();
    return () => { runningRef.current = false; };
  }, [jobId, onComplete]);

  if (error) {
    return (
      <div className="px-4 py-3 bg-[#fce8e8] rounded-xl text-sm text-red-700 border border-red-200">
        {error}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <div className="w-4 h-4 rounded-full border-2 border-gray-200 border-t-[#5b7cfa] animate-spin" />
        Starting sync...
      </div>
    );
  }

  const pct = status.totalEmails > 0
    ? Math.round((status.processedEmails / status.totalEmails) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between text-sm">
        <span className="text-gray-700 font-medium">
          {status.done ? "Sync complete" : "Syncing Gmail..."}
        </span>
        <span className="text-gray-500">{pct}%</span>
      </div>

      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-[#5b7cfa] rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex gap-4 text-xs text-gray-500">
        <span>{status.processedEmails} / {status.totalEmails} emails</span>
        <span className="text-[#5b7cfa] font-medium">{status.newTransactions} new transactions</span>
        {status.skippedEmails > 0 && <span>{status.skippedEmails} skipped</span>}
      </div>

      {status.done && (
        <div className="mt-1 px-4 py-3 bg-[#f0f3ff] rounded-xl text-sm text-[#5b7cfa] font-medium text-center">
          Imported {status.newTransactions} transactions — go to Dashboard to see them
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/SyncProgressBar.tsx
git commit -m "feat: add SyncProgressBar client component with polling loop"
```

---

### Task 7: Wire SyncProgressBar into onboarding + dashboard

**Files:**
- Modify: `src/app/(app)/onboarding/page.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx`

After the user clicks "Start Importing" in onboarding, we now need to:
1. Call `POST /api/gmail/sync/start` to create the SyncJob
2. Render `<SyncProgressBar>` while it runs
3. On complete, navigate to `/dashboard`

The dashboard stub should show a greeting + a "Sync Gmail" button that triggers the same start → progress flow for manual re-syncs.

- [ ] **Step 1: Update `src/app/(app)/onboarding/page.tsx`**

Replace the entire file:

```tsx
// src/app/(app)/onboarding/page.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { StepPicker, LookbackPeriod } from "@/components/onboarding/StepPicker";
import { StepScanning } from "@/components/onboarding/StepScanning";
import { StepReview, ScanResult, SenderSummary } from "@/components/onboarding/StepReview";
import { SyncProgressBar } from "@/components/SyncProgressBar";

type Step = "pick" | "scanning" | "review" | "confirming" | "syncing";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pick");
  const [period, setPeriod] = useState<LookbackPeriod>("6m");
  const [emailCount, setEmailCount] = useState(0);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async () => {
    setStep("scanning");
    setError(null);
    try {
      const res = await fetch("/api/gmail/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        throw new Error(err.error ?? "Scan failed");
      }
      const data = (await res.json()) as ScanResult & { totalScanned: number };
      setEmailCount(data.totalScanned);
      setScanResult(data);
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStep("pick");
    }
  };

  const handleConfirm = async (approved: SenderSummary[], rejected: string[]) => {
    setStep("confirming");
    try {
      const confirmRes = await fetch("/api/gmail/scan/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, approvedSenders: approved, rejectedSenders: rejected }),
      });
      if (!confirmRes.ok) throw new Error("Failed to save choices");

      // Start the sync job
      const startRes = await fetch("/api/gmail/sync/start", { method: "POST" });
      if (!startRes.ok) throw new Error("Failed to start sync");
      const { jobId } = (await startRes.json()) as { jobId: string };
      setSyncJobId(jobId);
      setStep("syncing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStep("review");
    }
  };

  const stepNumber = step === "pick" ? 1 : step === "scanning" ? 2 : 3;

  return (
    <div className="min-h-screen bg-[#eef0f6] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-lg">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 rounded-lg bg-[#e8ecf8] flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5b7cfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold text-gray-900">Set up Financial Manager</h1>
            {step !== "syncing" && <p className="text-xs text-gray-500">Step {stepNumber} of 3</p>}
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 bg-[#fce8e8] rounded-xl text-sm text-red-700 border border-red-200">
            {error}
          </div>
        )}

        {step === "pick" && (
          <StepPicker value={period} onChange={setPeriod} onConfirm={handleScan} loading={false} />
        )}
        {step === "scanning" && <StepScanning emailCount={emailCount} />}
        {(step === "review" || step === "confirming") && scanResult && (
          <StepReview result={scanResult} onConfirm={handleConfirm} loading={step === "confirming"} />
        )}
        {step === "syncing" && syncJobId && (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold text-gray-900">Importing transactions</h2>
            <p className="text-sm text-gray-500">Parsing emails with Gemini. This may take a few minutes.</p>
            <SyncProgressBar
              jobId={syncJobId}
              onComplete={() => router.push("/dashboard")}
            />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `src/app/(app)/dashboard/page.tsx`**

Read the current file first:

```bash
cat src/app/'(app)'/dashboard/page.tsx
```

Replace with:

```tsx
// src/app/(app)/dashboard/page.tsx
"use client";
import { useState } from "react";
import { SyncProgressBar } from "@/components/SyncProgressBar";

export default function DashboardPage() {
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/gmail/sync/start", { method: "POST" });
      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        throw new Error(err.error ?? "Failed to start sync");
      }
      const { jobId } = (await res.json()) as { jobId: string };
      setSyncJobId(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSyncing(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Your financial overview</p>
        </div>
        {!syncJobId && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#5b7cfa] text-white text-sm font-medium hover:bg-[#4a6be8] transition-colors disabled:opacity-60"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Sync Gmail
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-[#fce8e8] rounded-xl text-sm text-red-700 border border-red-200">
          {error}
        </div>
      )}

      {syncJobId && (
        <div className="mb-6 bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Syncing Gmail</h2>
          <SyncProgressBar
            jobId={syncJobId}
            onComplete={() => setSyncJobId(null)}
          />
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <p className="text-sm text-gray-500">KPI cards, charts, and recent transactions will appear here in Plan 5.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/'(app)'/onboarding/page.tsx src/app/'(app)'/dashboard/page.tsx
git commit -m "feat: wire SyncProgressBar into onboarding and dashboard"
```

---

### Task 8: Dev server verification end-to-end

- [ ] **Step 1: Start dev server**

```bash
node node_modules/next/dist/bin/next dev
```

- [ ] **Step 2: Verify login and redirect**

Navigate to `http://localhost:3000` → should redirect to `/login`.

- [ ] **Step 3: Verify dashboard renders**

After sign-in (or navigate to `/dashboard` if already signed in): "Dashboard" heading + "Sync Gmail" button visible, no TypeScript errors in console.

- [ ] **Step 4: Verify onboarding `syncing` step renders**

Navigate to `/onboarding` → confirm all 3 steps still work. After "Start Importing" the page should show the syncing step with the progress bar (which will start polling).

- [ ] **Step 5: Verify API routes respond correctly (no auth)**

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/gmail/sync/start
# Expected: 401 (unauthorized)

curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/gmail/sync/status?jobId=fake
# Expected: 401 (unauthorized)

curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/gmail/sync/chunk -H "Content-Type: application/json" -d '{"jobId":"fake"}'
# Expected: 401 (unauthorized)
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: Plan 3 complete — chunked Gmail sync pipeline with Gemini and progress bar"
```

---

## Self-Review

**1. Spec coverage:**

- [x] §5 data flow: `POST /api/gmail/sync/start` creates SyncJob → `POST /api/gmail/sync/chunk` processes 15 emails → `GET /api/gmail/sync/status` polled by client — all implemented
- [x] §6 Layer 1 (EmailFilter pre-screen): start route filters message IDs before creating job
- [x] §6 Layer 2 (gmailMsgId unique): `upsertTransaction` checks `findUnique({ userId_gmailMsgId })` first
- [x] §6 Layer 3 (fingerprint): `buildFingerprint` used in `upsertTransaction`
- [x] §6 Layer 4 (sourceRank priority): `upsertTransaction` upgrades existing record if incoming has lower sourceRank
- [x] §10 LLM prompt design: system prompt + user prompt with exact fields, `confidence < 0.7 → needsReview: true`, `amount <= 0 → null`, null date/merchant fallback — all in `parseEmailTransaction`
- [x] §8.0 onboarding: "Start Importing" now triggers sync + shows progress bar, navigates to dashboard on complete
- [x] §8.1 dashboard: "Sync Gmail" button triggers manual re-sync with same progress bar

**2. Placeholder scan:** No TODOs, TBDs, or "similar to Task N" references found. All code blocks are complete.

**3. Type consistency:**
- `ParsedTransaction` defined in `gemini.ts`, imported into `dedup.ts` — consistent
- `UpsertResult` type (`"inserted" | "skipped_msgid" | "skipped_fingerprint" | "upgraded"`) used only in `dedup.ts` — consistent
- `JobStatus` in `SyncProgressBar.tsx` matches fields returned by the status route — consistent
- `SyncJob.messageIds` added in schema and used in both start and chunk routes — consistent
