# Gmail Sync Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken cron-driven Gmail sync with a client-driven polling architecture that handles 10K+ email inboxes, fixes the Vercel deployment failure, and adds incremental sync via a watermark.

**Architecture:** Browser polls `/api/gmail/sync/advance` every 5s while tab is open (client-driven); a daily Vercel cron (`0 2 * * *`) is a safety net. The advance endpoint accepts either a valid session cookie (client call) or `Authorization: Bearer <CRON_SECRET>` (cron). Gmail Batch API fetches 50 full messages per tick in 1 HTTP call instead of 50. One Gemini call per tick processes all 50 emails. The `gmailSyncedAt` watermark gates incremental vs first-time syncs.

**Tech Stack:** Next.js 16, Prisma 7, Neon PostgreSQL, Vercel Hobby, Gmail API, Gemini Flash (free tier), NextAuth v5

**Spec:** `docs/superpowers/specs/2026-07-12-gmail-sync-redesign.md`

---

## File Map

| File | Action | What changes |
|---|---|---|
| `vercel.json` | Modify | Fix cron schedule `*/15` → `0 2 * * *` |
| `prisma/schema.prisma` | Modify | Add `GeminiUsageLog` model |
| `src/lib/gmail.ts` | Modify | Add `fetchFullMessageBatch()` using Gmail Batch API |
| `src/app/api/gmail/sync/advance/route.ts` | Rewrite | Session auth, chunk=50, Batch API, rate limit check, set `gmailSyncedAt` |
| `src/app/api/gmail/scan/route.ts` | Modify | Paginate through all Gmail pages (fix 500-email cap) |
| `src/app/api/gmail/sync/start/route.ts` | Modify | Incremental path: if `gmailSyncedAt` set, use it as `fromDate` |
| `src/app/api/user/data/route.ts` | Modify | Also reset `gmailSyncedAt = null` on clear-all |
| `src/components/SyncProgressBanner.tsx` | Modify | 5s poll, drive advance endpoint, add `rate_limited` state |
| `src/app/(app)/onboarding/page.tsx` | Modify | Add "Skip preview" button, wire advance polling in step 3 |
| `src/app/(app)/settings/page.tsx` | Modify | Add "Sync now" button + "Last synced: X" display |
| `src/lib/auth.config.ts` | No change | advance endpoint already in public whitelist |
| `tests/lib/gmail.test.ts` | Modify | Add tests for `fetchFullMessageBatch` |
| `tests/schema/schema.test.ts` | Modify | Add `geminiUsageLog` to model list |

---

## Task 1: Fix vercel.json — Unblock Deployment (5 min)

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1.1: Update the cron schedule**

```json
{
  "buildCommand": "npx prisma generate && next build",
  "crons": [
    {
      "path": "/api/gmail/sync/advance",
      "schedule": "0 2 * * *"
    }
  ]
}
```

- [ ] **Step 1.2: Verify no other cron schedules exist**

Run:
```bash
grep -r "schedule" vercel.json
```
Expected: only `"schedule": "0 2 * * *"`

- [ ] **Step 1.3: Commit**

```bash
git add vercel.json
git commit -m "fix(cron): change schedule to 0 2 * * * — Hobby plan requires daily minimum"
```

---

## Task 2: Add GeminiUsageLog Schema (10 min)

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `tests/schema/schema.test.ts`

- [ ] **Step 2.1: Write the failing schema test**

Add to `tests/schema/schema.test.ts` inside the first `it` block — extend the model list check:

```typescript
// In the existing "Prisma generated types include all expected models" test,
// add this line alongside the other model variables:
const _geminiUsageLog: ModelNames = "geminiUsageLog";
```

And update the `expect` at the end:
```typescript
expect([_user, _account, _session, _transaction, _emailFilter, _syncJob,
  _reconciliationLog, _asset, _verificationToken, _geminiUsageLog]).toHaveLength(10);
```

- [ ] **Step 2.2: Run the test to confirm it fails**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager
npx jest tests/schema/schema.test.ts --no-coverage 2>&1 | tail -20
```
Expected: FAIL — `geminiUsageLog` not in ModelNames

- [ ] **Step 2.3: Add GeminiUsageLog model to schema**

In `prisma/schema.prisma`, append after the last model:

```prisma
model GeminiUsageLog {
  id        String   @id @default(cuid())
  date      String   // YYYY-MM-DD (UTC) — one row per calendar day
  callCount Int      @default(0)

  @@unique([date])
}
```

- [ ] **Step 2.4: Generate the Prisma client**

```bash
npx prisma generate
```
Expected: `✔ Generated Prisma Client`

- [ ] **Step 2.5: Run the test to confirm it passes**

```bash
npx jest tests/schema/schema.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 2.6: Commit**

```bash
git add prisma/schema.prisma tests/schema/schema.test.ts
git commit -m "feat(schema): add GeminiUsageLog model for rate limit tracking"
```

---

## Task 3: Add Gmail Batch API Helper (30 min)

**Files:**
- Modify: `src/lib/gmail.ts`
- Modify: `tests/lib/gmail.test.ts`

The Gmail Batch API packs up to 100 `messages.get` sub-requests into one multipart/mixed HTTP call, reducing 50 individual calls (~2.5–10s) to 1 call (~300–600ms).

- [ ] **Step 3.1: Write the failing test**

Add to `tests/lib/gmail.test.ts`:

```typescript
import { parseBatchResponse, type FullMessage } from "@/lib/gmail";

describe("parseBatchResponse", () => {
  it("parses a multipart/mixed Gmail batch response into FullMessage array", () => {
    // Build a mock multipart/mixed response body with two sub-responses
    const boundary = "batch_boundary_test";
    const msg1Headers = "From: Test Sender <test@example.com>\r\nDate: Thu, 01 Jan 2026 10:00:00 +0000\r\n";
    const msg2Headers = "From: Bank <noreply@hdfcbank.com>\r\nDate: Fri, 02 Jan 2026 12:00:00 +0000\r\n";

    const subResp1 = [
      `--${boundary}`,
      "Content-Type: application/http",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "",
      JSON.stringify({
        id: "msg1",
        internalDate: "1735725600000",
        payload: {
          headers: [
            { name: "From", value: "Test Sender <test@example.com>" },
            { name: "Subject", value: "Your payment receipt" },
          ],
          body: { data: Buffer.from("You paid ₹500 to Amazon").toString("base64") },
        },
      }),
    ].join("\r\n");

    const subResp2 = [
      `--${boundary}`,
      "Content-Type: application/http",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "",
      JSON.stringify({
        id: "msg2",
        internalDate: "1735812000000",
        payload: {
          headers: [
            { name: "From", value: "noreply@hdfcbank.com" },
            { name: "Subject", value: "Debit alert" },
          ],
          body: { data: Buffer.from("Rs 2000 debited from your account").toString("base64") },
        },
      }),
    ].join("\r\n");

    const body = `${subResp1}\r\n${subResp2}\r\n--${boundary}--`;
    const results = parseBatchResponse(body, boundary);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("msg1");
    expect(results[0].senderEmail).toBe("test@example.com");
    expect(results[0].body).toContain("₹500");
    expect(results[1].id).toBe("msg2");
    expect(results[1].senderEmail).toBe("noreply@hdfcbank.com");
  });

  it("skips sub-responses with non-200 status", () => {
    const boundary = "b";
    const body = [
      `--${boundary}`,
      "Content-Type: application/http",
      "",
      "HTTP/1.1 404 Not Found",
      "Content-Type: application/json",
      "",
      JSON.stringify({ error: { code: 404 } }),
      `--${boundary}--`,
    ].join("\r\n");

    const results = parseBatchResponse(body, boundary);
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 3.2: Run the test to confirm it fails**

```bash
npx jest tests/lib/gmail.test.ts --no-coverage 2>&1 | tail -20
```
Expected: FAIL — `parseBatchResponse` not exported from `@/lib/gmail`

- [ ] **Step 3.3: Add FullMessage type and parseBatchResponse to gmail.ts**

Add after the `fetchMessageIdPage` function in `src/lib/gmail.ts`:

```typescript
export type FullMessage = {
  id: string;
  body: string;
  senderName: string;
  senderEmail: string;
  senderDomain: string;
  receivedDate: string; // YYYY-MM-DD
  hasPdfAttachment: boolean;
  pdfAttachmentId: string | null;
};

export function parseBatchResponse(responseBody: string, boundary: string): FullMessage[] {
  const results: FullMessage[] = [];
  const parts = responseBody.split(`--${boundary}`);

  for (const part of parts) {
    // Find the HTTP response body within each multipart part
    const httpBodyStart = part.indexOf("HTTP/1.1");
    if (httpBodyStart === -1) continue;
    const httpSection = part.slice(httpBodyStart);

    // Extract status code from first line
    const statusLine = httpSection.split("\r\n")[0] ?? httpSection.split("\n")[0] ?? "";
    const statusMatch = statusLine.match(/HTTP\/1\.\d\s+(\d+)/);
    if (!statusMatch || statusMatch[1] !== "200") continue;

    // Find JSON body (after the blank line following HTTP headers)
    const jsonStart = httpSection.indexOf("\r\n\r\n");
    const jsonStartFallback = httpSection.indexOf("\n\n");
    const bodyStart = jsonStart !== -1 ? jsonStart + 4 : jsonStartFallback !== -1 ? jsonStartFallback + 2 : -1;
    if (bodyStart === -1) continue;

    let msg: {
      id?: string;
      internalDate?: string;
      payload?: {
        headers?: Array<{ name: string; value: string }>;
        body?: { data?: string };
        parts?: Array<{ mimeType: string; body?: { data?: string; attachmentId?: string } }>;
      };
    };

    try {
      msg = JSON.parse(httpSection.slice(bodyStart).trim());
    } catch {
      continue;
    }

    if (!msg.id) continue;

    const headers = msg.payload?.headers ?? [];
    const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
    const senderRaw = get("From");
    const senderName = senderRaw.replace(/<[^>]+>/, "").trim() || senderRaw;
    const emailMatch = senderRaw.match(/<([^>]+)>/);
    const senderEmail = emailMatch ? emailMatch[1] : senderRaw.replace(/\s+/g, "");
    const senderDomain = senderEmail.includes("@") ? senderEmail.split("@")[1] : senderEmail;
    const receivedDate = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];

    let body = "";
    const parts2 = msg.payload?.parts ?? [];
    const plainPart = parts2.find((p) => p.mimeType === "text/plain");
    const htmlPart = parts2.find((p) => p.mimeType === "text/html");
    const rawData = plainPart?.body?.data ?? htmlPart?.body?.data ?? msg.payload?.body?.data ?? "";
    if (rawData) {
      const decoded = Buffer.from(rawData, "base64url").toString("utf-8");
      body = decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    const pdfParts = parts2.filter((p) => p.mimeType === "application/pdf" && p.body?.attachmentId);
    const hasPdfAttachment = pdfParts.length > 0;
    const pdfAttachmentId = hasPdfAttachment ? pdfParts[0].body!.attachmentId! : null;

    results.push({ id: msg.id, body, senderName, senderEmail, senderDomain, receivedDate, hasPdfAttachment, pdfAttachmentId });
  }

  return results;
}

export async function fetchFullMessageBatch(
  accessToken: string,
  messageIds: string[]
): Promise<FullMessage[]> {
  if (messageIds.length === 0) return [];

  const boundary = "gmail_batch_boundary";
  const subRequests = messageIds
    .map(
      (id) =>
        `--${boundary}\r\nContent-Type: application/http\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=full\r\n`
    )
    .join("");
  const batchBody = subRequests + `--${boundary}--`;

  const res = await fetch("https://www.googleapis.com/batch/gmail/v1", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/mixed; boundary=${boundary}`,
    },
    body: batchBody,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[gmail] fetchFullMessageBatch failed: ${res.status}`, err);
    if (res.status === 429) throw new Error("GMAIL_RATE_LIMITED");
    throw new Error(`Gmail batch failed: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  const responseBoundary = boundaryMatch?.[1] ?? boundary;
  const responseBody = await res.text();

  return parseBatchResponse(responseBody, responseBoundary);
}
```

- [ ] **Step 3.4: Run the test to confirm it passes**

```bash
npx jest tests/lib/gmail.test.ts --no-coverage 2>&1 | tail -15
```
Expected: PASS (all 6 tests including the 2 new ones)

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/gmail.ts tests/lib/gmail.test.ts
git commit -m "feat(gmail): add fetchFullMessageBatch using Gmail Batch API — 50 msgs in 1 HTTP call"
```

---

## Task 4: Refactor Advance Endpoint (45 min)

**Files:**
- Rewrite: `src/app/api/gmail/sync/advance/route.ts`

This is the engine. Key changes: (1) accepts session auth for client-driven polling, (2) chunk size 50, (3) uses Gmail Batch API instead of 50 individual calls, (4) checks GeminiUsageLog before calling Gemini, (5) sets `user.gmailSyncedAt = completedAt` when job completes.

NOTE: Read `node_modules/next/dist/docs/` for Next.js 16 route handler patterns before editing.

- [ ] **Step 4.1: Write tests for the Gemini rate limit helper**

Create `tests/lib/geminiRateLimit.test.ts`:

```typescript
import { checkGeminiRateLimit, incrementGeminiUsage } from "@/lib/geminiRateLimit";
import { prisma } from "@/lib/prisma";

// Mock prisma
jest.mock("@/lib/prisma", () => ({
  prisma: {
    geminiUsageLog: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

describe("checkGeminiRateLimit", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns ok when callCount is below 1400", async () => {
    (prisma.geminiUsageLog.findUnique as jest.Mock).mockResolvedValue({ callCount: 100, date: "2026-07-12" });
    const result = await checkGeminiRateLimit();
    expect(result.allowed).toBe(true);
  });

  it("returns rate_limited when callCount >= 1400", async () => {
    (prisma.geminiUsageLog.findUnique as jest.Mock).mockResolvedValue({ callCount: 1400, date: "2026-07-12" });
    const result = await checkGeminiRateLimit();
    expect(result.allowed).toBe(false);
    expect(result.resumesAt).toBeTruthy();
  });

  it("returns ok when no log exists yet (first call today)", async () => {
    (prisma.geminiUsageLog.findUnique as jest.Mock).mockResolvedValue(null);
    const result = await checkGeminiRateLimit();
    expect(result.allowed).toBe(true);
  });
});

describe("incrementGeminiUsage", () => {
  it("upserts with increment", async () => {
    (prisma.geminiUsageLog.upsert as jest.Mock).mockResolvedValue({ callCount: 1 });
    await incrementGeminiUsage();
    expect(prisma.geminiUsageLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ callCount: expect.anything() }),
      })
    );
  });
});
```

- [ ] **Step 4.2: Run the test to confirm it fails**

```bash
npx jest tests/lib/geminiRateLimit.test.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL — module not found

- [ ] **Step 4.3: Create src/lib/geminiRateLimit.ts**

```typescript
import { prisma } from "@/lib/prisma";

const DAILY_LIMIT = 1400; // Buffer before 1500 hard limit

function todayUtc(): string {
  return new Date().toISOString().split("T")[0];
}

export async function checkGeminiRateLimit(): Promise<{ allowed: boolean; resumesAt?: string }> {
  const today = todayUtc();
  const log = await prisma.geminiUsageLog.findUnique({ where: { date: today } });
  const count = log?.callCount ?? 0;
  if (count >= DAILY_LIMIT) {
    // Next midnight UTC
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return { allowed: false, resumesAt: tomorrow.toISOString() };
  }
  return { allowed: true };
}

export async function incrementGeminiUsage(): Promise<void> {
  const today = todayUtc();
  await prisma.geminiUsageLog.upsert({
    where: { date: today },
    create: { date: today, callCount: 1 },
    update: { callCount: { increment: 1 } },
  });
}
```

- [ ] **Step 4.4: Run the test to confirm it passes**

```bash
npx jest tests/lib/geminiRateLimit.test.ts --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 4.5: Rewrite the advance route**

Replace `src/app/api/gmail/sync/advance/route.ts` entirely:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken, fetchMessageIdPage, fetchFullMessageBatch, fetchPdfAttachment } from "@/lib/gmail";
import { parseEmailBatch, type BatchInput } from "@/lib/gemini";
import { upsertTransactionV2 } from "@/lib/dedup";
import { matchesEmailFilter } from "@/lib/emailFilter";
import { checkGeminiRateLimit, incrementGeminiUsage } from "@/lib/geminiRateLimit";

const CHUNK_SIZE = 50;
const BODY_LIMIT = 1500;

async function advanceJob(job: {
  id: string;
  userId: string;
}): Promise<{
  phase: "running" | "complete" | "rate_limited";
  newTransactions: number;
  processed?: number;
  total?: number;
  source?: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";

  const pending = await prisma.syncJobMessage.findMany({
    where: { syncJobId: job.id, processed: false },
    take: CHUNK_SIZE,
    orderBy: { id: "asc" },
    select: { id: true, gmailMsgId: true },
  });

  if (pending.length === 0) {
    const completedAt = new Date();
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "complete", completedAt },
    });
    await prisma.user.update({
      where: { id: job.userId },
      data: { gmailSyncedAt: completedAt },
    });
    return { phase: "complete", newTransactions: 0 };
  }

  const accessToken = await getGmailToken(job.userId);
  if (!accessToken) {
    await prisma.syncJob.update({ where: { id: job.id }, data: { status: "failed", completedAt: new Date() } });
    return { phase: "rate_limited", newTransactions: 0, source: "gmail_token" };
  }

  // Fetch all 50 full messages in ONE Gmail Batch API call
  let fetched;
  try {
    fetched = await fetchFullMessageBatch(accessToken, pending.map((p) => p.gmailMsgId));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "GMAIL_RATE_LIMITED") {
      return { phase: "rate_limited", newTransactions: 0, source: "gmail" };
    }
    throw err;
  }

  const fetchedMap = new Map(fetched.map((m) => [m.id, m]));

  // Fetch PDF attachments where needed
  for (const msg of fetched) {
    if (msg.hasPdfAttachment && msg.pdfAttachmentId) {
      const pdfResult = await fetchPdfAttachment(accessToken, msg.id, msg.pdfAttachmentId);
      if (pdfResult.status === "ok") {
        msg.body = (msg.body + "\n\n" + pdfResult.text).trim();
      }
    }
  }

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });
  const merchantRules = await prisma.merchantRule.findMany({
    where: { userId: job.userId },
    select: { merchantName: true, category: true },
  });
  const merchantRuleMap = new Map(merchantRules.map((r) => [r.merchantName, r.category]));

  type ProcessableEmail = {
    msgId: string;
    body: string;
    senderName: string;
    senderDomain: string;
    receivedDate: string;
    sourceRank: number;
    rowId: string;
  };

  const filteredLogs: Array<{
    userId: string; syncJobId: string; gmailMsgId: string; senderDomain: string;
    bodyLengthRaw: number; bodyLengthSent: number; wasTruncated: boolean; batchSize: number; outcome: string;
  }> = [];
  const toProcess: ProcessableEmail[] = [];

  for (const { id: rowId, gmailMsgId } of pending) {
    const msg = fetchedMap.get(gmailMsgId);
    if (!msg) continue;

    const filterResult = matchesEmailFilter({ from: msg.senderEmail, subject: "" }, filters);
    if (!filterResult.matched) {
      filteredLogs.push({
        userId: job.userId, syncJobId: job.id, gmailMsgId,
        senderDomain: msg.senderDomain, bodyLengthRaw: msg.body.length,
        bodyLengthSent: Math.min(msg.body.length, BODY_LIMIT),
        wasTruncated: msg.body.length > BODY_LIMIT, batchSize: 1, outcome: "skipped_filter",
      });
      continue;
    }
    toProcess.push({ msgId: gmailMsgId, body: msg.body, senderName: msg.senderName,
      senderDomain: msg.senderDomain, receivedDate: msg.receivedDate,
      sourceRank: filterResult.sourceRank, rowId });
  }

  if (filteredLogs.length > 0) {
    await prisma.parseLog.createMany({ data: filteredLogs });
  }

  let newTransactions = 0;

  if (toProcess.length > 0) {
    // Check Gemini rate limit before calling
    const rateCheck = await checkGeminiRateLimit();
    if (!rateCheck.allowed) {
      return { phase: "rate_limited", newTransactions: 0, source: "gemini" };
    }

    const batchInputs: BatchInput[] = toProcess.map((e, idx) => ({
      emailIndex: idx,
      body: e.body,
      senderName: e.senderName,
      fallbackDate: e.receivedDate,
    }));

    const results = await parseEmailBatch(batchInputs, apiKey);
    await incrementGeminiUsage();

    for (const result of results) {
      const email = toProcess[result.emailIndex];
      if (!email) continue;

      const logBase = {
        userId: job.userId, syncJobId: job.id, gmailMsgId: email.msgId,
        senderDomain: email.senderDomain, emailDate: new Date(email.receivedDate),
        bodyLengthRaw: result.bodyLengthRaw, bodyLengthSent: result.bodyLengthSent,
        wasTruncated: result.wasTruncated, batchSize: toProcess.length,
      };

      if (result.outcome !== "parsed") {
        await prisma.parseLog.create({ data: { ...logBase, outcome: result.outcome } });
        continue;
      }

      let category = result.category!;
      const merchantKey = result.merchant!.toLowerCase().trim();
      const overrideCategory = merchantRuleMap.get(merchantKey);
      if (overrideCategory) category = overrideCategory;

      const upsertResult = await upsertTransactionV2(prisma, {
        userId: job.userId, gmailMsgId: email.msgId, date: new Date(result.date!),
        merchant: result.merchant!, amount: result.amount!, type: result.type!,
        currency: result.currency!, category, source: "gmail",
        sourceRank: email.sourceRank, confidence: result.confidence, needsReview: result.needsReview,
      });

      const outcome = upsertResult.action === "inserted" ? "inserted"
        : upsertResult.action === "upgraded" ? "upgraded" : "skipped_duplicate";
      if (outcome === "inserted") newTransactions++;

      await prisma.parseLog.create({
        data: { ...logBase, outcome, geminiConfidence: result.confidence,
          parsedMerchant: result.merchant, parsedAmount: result.amount, transactionId: upsertResult.id },
      });
    }
  }

  await prisma.syncJobMessage.updateMany({
    where: { id: { in: pending.map((p) => p.id) } },
    data: { processed: true },
  });

  const processedCount = await prisma.syncJobMessage.count({ where: { syncJobId: job.id, processed: true } });
  const totalCount = await prisma.syncJobMessage.count({ where: { syncJobId: job.id } });
  const isDone = processedCount >= totalCount;

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      processedEmails: processedCount,
      newTransactions: { increment: newTransactions },
      ...(isDone ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  if (isDone) {
    const completedAt = new Date();
    await prisma.syncJob.update({ where: { id: job.id }, data: { completedAt } });
    await prisma.user.update({ where: { id: job.userId }, data: { gmailSyncedAt: completedAt } });
    return { phase: "complete", newTransactions, processed: processedCount, total: totalCount };
  }

  return { phase: "running", newTransactions, processed: processedCount, total: totalCount };
}

export async function GET(req: NextRequest) {
  // Auth: accept valid session (client) OR Bearer token (cron)
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const querySecret = req.nextUrl.searchParams.get("secret");
  const providedToken = bearerToken ?? querySecret;
  const isCron = !!process.env.CRON_SECRET && providedToken === process.env.CRON_SECRET;

  let sessionUserId: string | null = null;
  if (!isCron) {
    const session = await auth();
    sessionUserId = session?.user?.id ?? null;
    if (!sessionUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Scanning phase — advance one page per tick
  const scanFilter = isCron
    ? { status: "scanning" }
    : { status: "scanning", userId: sessionUserId! };

  const scanningJobs = await prisma.syncJob.findMany({
    where: scanFilter,
    select: { id: true, userId: true, gmailQuery: true, scanPageToken: true },
  });

  for (const job of scanningJobs) {
    const accessToken = await getGmailToken(job.userId);
    if (!accessToken) {
      await prisma.syncJob.update({ where: { id: job.id }, data: { status: "failed", completedAt: new Date() } });
      continue;
    }
    const page = await fetchMessageIdPage(accessToken, job.gmailQuery ?? "", job.scanPageToken ?? undefined);
    if (page.messageIds.length > 0) {
      await prisma.syncJobMessage.createMany({
        data: page.messageIds.map((id) => ({ syncJobId: job.id, gmailMsgId: id, processed: false })),
        skipDuplicates: true,
      });
    }
    const totalCount = await prisma.syncJobMessage.count({ where: { syncJobId: job.id } });
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { totalEmails: totalCount, scanPageToken: page.nextPageToken ?? null,
        status: page.nextPageToken ? "scanning" : "running" },
    });
  }

  // Processing phase
  const runFilter = isCron
    ? { status: "running" }
    : { status: "running", userId: sessionUserId! };

  const runningJobs = await prisma.syncJob.findMany({
    where: runFilter,
    orderBy: { startedAt: "asc" },
    select: { id: true, userId: true },
  });

  const results = [];
  for (const job of runningJobs) {
    const result = await advanceJob(job);
    results.push({ jobId: job.id, ...result });
  }

  // Prune old parse logs (cron only)
  if (isCron) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const pruned = await prisma.parseLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return NextResponse.json({ jobs: results, pruned: pruned.count });
  }

  // For client calls: return the current job state for polling
  const jobId = scanningJobs[0]?.id ?? runningJobs[0]?.id;
  if (!jobId) {
    return NextResponse.json({ phase: "idle" });
  }
  const job = await prisma.syncJob.findUnique({
    where: { id: jobId },
    select: { status: true, totalEmails: true, processedEmails: true, newTransactions: true },
  });
  const resultSummary = results[0];
  if (resultSummary?.phase === "rate_limited") {
    return NextResponse.json({ phase: "rate_limited", source: resultSummary.source });
  }
  if (job?.status === "complete") {
    return NextResponse.json({ phase: "complete", newTransactions: job.newTransactions });
  }
  if (job?.status === "scanning") {
    return NextResponse.json({ phase: "scanning", scanned: job.totalEmails });
  }
  return NextResponse.json({
    phase: "running",
    processed: job?.processedEmails ?? 0,
    total: job?.totalEmails ?? 0,
    newTransactions: job?.newTransactions ?? 0,
  });
}
```

- [ ] **Step 4.6: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -20
```
Expected: All tests PASS

- [ ] **Step 4.7: Commit**

```bash
git add src/app/api/gmail/sync/advance/route.ts src/lib/geminiRateLimit.ts tests/lib/geminiRateLimit.test.ts
git commit -m "feat(advance): session auth, Gmail Batch API chunk-50, Gemini rate limit, set gmailSyncedAt on complete"
```

---

## Task 5: Fix Scan Route Pagination (15 min)

**Files:**
- Modify: `src/app/api/gmail/scan/route.ts`

Currently fetches one page (500 emails max). Fix: loop through all pages collecting metadata.

- [ ] **Step 5.1: Update scan/route.ts to paginate**

Replace the scan section (lines 33–35) in `src/app/api/gmail/scan/route.ts`:

```typescript
  // Old (ONE page only):
  // const page = await fetchMessageMetadataList(accessToken, fromDate, undefined, gmailQuery);
  // const allMessages = page.messages;

  // New (paginate through ALL pages):
  let allMessages: Awaited<ReturnType<typeof fetchMessageMetadataList>>["messages"] = [];
  let pageToken: string | undefined = undefined;
  do {
    const page = await fetchMessageMetadataList(accessToken, fromDate, pageToken, gmailQuery);
    allMessages = allMessages.concat(page.messages);
    pageToken = page.nextPageToken;
  } while (pageToken);
```

The full updated `src/app/api/gmail/scan/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getGmailToken,
  fetchMessageMetadataList,
  classifySenders,
  buildScanFromDate,
  LookbackPeriod,
} from "@/lib/gmail";
import { buildGmailQuery } from "@/lib/gmailQuery";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await req.json()) as { period?: LookbackPeriod };
  const period: LookbackPeriod = body.period ?? "6m";

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const fromDate = buildScanFromDate(period);
  const gmailQuery = buildGmailQuery(fromDate);

  // Paginate through ALL pages — no longer limited to 500
  let allMessages: Awaited<ReturnType<typeof fetchMessageMetadataList>>["messages"] = [];
  let pageToken: string | undefined = undefined;
  do {
    const page = await fetchMessageMetadataList(accessToken, fromDate, pageToken, gmailQuery);
    allMessages = allMessages.concat(page.messages);
    pageToken = page.nextPageToken;
  } while (pageToken);

  console.log(`[scan] fetched ${allMessages.length} messages total after pagination`);

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });
  const scanResult = classifySenders(allMessages, filters);

  const filterValues = new Set(filters.map((f) => f.value));
  for (const s of scanResult.autoApproved) {
    s.existsInFilter = filterValues.has(s.domain) || filterValues.has(s.sender);
  }

  return NextResponse.json({
    period,
    fromDate: fromDate.toISOString(),
    ...scanResult,
  });
}
```

- [ ] **Step 5.2: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 5.3: Commit**

```bash
git add src/app/api/gmail/scan/route.ts
git commit -m "fix(scan): paginate through all Gmail pages — no longer capped at 500 emails"
```

---

## Task 6: Fix Sync Start — Incremental Path (15 min)

**Files:**
- Modify: `src/app/api/gmail/sync/start/route.ts`

Currently always uses `user.syncFromDate` (set during onboarding). Fix: if `user.gmailSyncedAt` is set, use `gmailSyncedAt - 24h` as the fromDate (no period picker needed).

- [ ] **Step 6.1: Update sync/start/route.ts**

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { buildGmailQuery } from "@/lib/gmailQuery";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const existingJob = await prisma.syncJob.findFirst({
    where: { userId, status: { in: ["scanning", "running"] } },
    select: { id: true },
  });
  if (existingJob) {
    return NextResponse.json(
      { error: "A sync is already in progress", jobId: existingJob.id, running: true },
      { status: 409 }
    );
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { syncFromDate: true, gmailSyncedAt: true },
  });

  let fromDate: Date;
  if (user?.gmailSyncedAt) {
    // Incremental sync: start from watermark - 24h to catch delayed emails
    fromDate = new Date(user.gmailSyncedAt.getTime() - 24 * 60 * 60 * 1000);
  } else {
    // First sync: use the period the user selected during onboarding (or default 6m)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    fromDate = user?.syncFromDate ?? sixMonthsAgo;
  }

  const gmailQuery = buildGmailQuery(fromDate);

  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: 0,
      status: "scanning",
      gmailQuery,
      scanPageToken: null,
    },
  });

  console.log(`[sync/start] userId=${userId} jobId=${job.id} fromDate=${fromDate.toISOString()} incremental=${!!user?.gmailSyncedAt}`);
  return NextResponse.json({ jobId: job.id });
}
```

- [ ] **Step 6.2: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 6.3: Commit**

```bash
git add src/app/api/gmail/sync/start/route.ts
git commit -m "feat(sync/start): incremental path uses gmailSyncedAt-24h watermark"
```

---

## Task 7: Fix Clear-All to Reset Watermark (5 min)

**Files:**
- Modify: `src/app/api/user/data/route.ts`

The "Delete all data" button must reset `gmailSyncedAt = null` so the next sync restarts from the period picker.

- [ ] **Step 7.1: Add gmailSyncedAt reset to DELETE handler**

In `src/app/api/user/data/route.ts`, add after the cancellation block and before the parallel deletes:

```typescript
  // Reset watermark so next sync restarts from period picker
  await prisma.user.update({
    where: { id: userId },
    data: { gmailSyncedAt: null },
  });
```

- [ ] **Step 7.2: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 7.3: Commit**

```bash
git add src/app/api/user/data/route.ts
git commit -m "fix(user/data): reset gmailSyncedAt on clear-all so next sync restarts from period picker"
```

---

## Task 8: Update SyncProgressBanner — 5s Poll + Rate Limited State (20 min)

**Files:**
- Modify: `src/components/SyncProgressBanner.tsx`

Key changes: (1) poll interval 5s while active, (2) drive the advance endpoint directly (not just status), (3) add `rate_limited` state display.

- [ ] **Step 8.1: Update SyncProgressBanner.tsx**

Replace `src/components/SyncProgressBanner.tsx` entirely:

```typescript
"use client";
import { useEffect, useState, useCallback } from "react";

type AdvanceResponse =
  | { phase: "idle" }
  | { phase: "scanning"; scanned: number }
  | { phase: "running"; processed: number; total: number; newTransactions: number }
  | { phase: "rate_limited"; source?: string }
  | { phase: "complete"; newTransactions: number };

type SyncJob = {
  id: string;
  status: "scanning" | "running" | "complete" | "failed" | "cancelled";
  totalEmails: number;
  processedEmails: number;
  newTransactions: number;
  encryptedBlockedCount: number;
  startedAt: string;
  completedAt: string | null;
};

const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 60_000;
const AUTO_DISMISS_MS = 10_000;

function isDismissed(jobId: string): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(`sync-banner-dismissed-${jobId}`) === "1";
}

function setDismissed(jobId: string) {
  sessionStorage.setItem(`sync-banner-dismissed-${jobId}`, "1");
}

export function SyncProgressBanner() {
  const [job, setJob] = useState<SyncJob | null>(null);
  const [advancePhase, setAdvancePhase] = useState<AdvanceResponse | null>(null);
  const [dismissed, setDismissedState] = useState(false);

  const tick = useCallback(async () => {
    try {
      // First check if there's an active job
      const statusRes = await fetch("/api/gmail/sync/active");
      if (!statusRes.ok) return;
      const jobData: SyncJob | null = await statusRes.json();
      if (!jobData) { setJob(null); return; }
      if (isDismissed(jobData.id)) { setDismissedState(true); return; }
      setJob(jobData);
      setDismissedState(false);

      // If job is active, drive the advance endpoint
      if (jobData.status === "scanning" || jobData.status === "running") {
        const advRes = await fetch("/api/gmail/sync/advance");
        if (advRes.ok) {
          const adv: AdvanceResponse = await advRes.json();
          setAdvancePhase(adv);
        }
      }
    } catch {
      // ignore network errors
    }
  }, []);

  useEffect(() => {
    tick();
    const isActive = job?.status === "scanning" || job?.status === "running";
    const interval = setInterval(tick, isActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => clearInterval(interval);
  }, [tick, job?.status]);

  // Auto-dismiss complete banner
  useEffect(() => {
    if (job?.status === "complete" && job.encryptedBlockedCount === 0) {
      const timer = setTimeout(() => {
        setDismissed(job.id);
        setDismissedState(true);
      }, AUTO_DISMISS_MS);
      return () => clearTimeout(timer);
    }
  }, [job]);

  if (!job || dismissed) return null;

  const pct = job.totalEmails > 0 ? Math.round((job.processedEmails / job.totalEmails) * 100) : 0;
  const handleDismiss = () => { setDismissed(job.id); setDismissedState(true); };

  if (advancePhase?.phase === "rate_limited") {
    return (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-amber-800">
            Processing paused — daily quota reached ({advancePhase.source ?? "api"}).
            Resumes automatically at midnight UTC.
          </span>
          <button onClick={handleDismiss} className="ml-4 text-amber-500 hover:text-amber-700 text-sm">✕</button>
        </div>
      </div>
    );
  }

  if (job.status === "scanning") {
    const scanned = advancePhase?.phase === "scanning" ? advancePhase.scanned : job.totalEmails;
    return (
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-blue-800 font-medium">
              Scanning your Gmail… {scanned > 0 ? `${scanned.toLocaleString()} emails found so far` : ""}
            </span>
          </div>
          <p className="text-xs text-blue-600 mt-1">This runs in the background — you can navigate freely</p>
        </div>
      </div>
    );
  }

  if (job.status === "running") {
    const processed = advancePhase?.phase === "running" ? advancePhase.processed : job.processedEmails;
    const total = advancePhase?.phase === "running" ? advancePhase.total : job.totalEmails;
    const txns = advancePhase?.phase === "running" ? advancePhase.newTransactions : job.newTransactions;
    const livePct = total > 0 ? Math.round((processed / total) * 100) : pct;
    return (
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-blue-800 font-medium">
              Importing Gmail transactions… {processed.toLocaleString()} / {total.toLocaleString()}
            </span>
            <span className="text-sm text-blue-600 font-semibold">{livePct}%</span>
          </div>
          <div className="h-1.5 bg-blue-200 rounded-full">
            <div className="h-full bg-blue-600 rounded-full transition-all duration-300" style={{ width: `${livePct}%` }} />
          </div>
          <p className="text-xs text-blue-600 mt-1">
            {txns} new transactions found · updates every 5 seconds
          </p>
        </div>
      </div>
    );
  }

  if (job.status === "complete" && job.encryptedBlockedCount > 0) {
    return (
      <div className="bg-orange-50 border-b border-orange-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-orange-800">
            Sync complete — {job.newTransactions} transactions imported, but{" "}
            <strong>{job.encryptedBlockedCount} encrypted statements</strong> couldn&apos;t be read.{" "}
            <a href="/settings?tab=statement-passwords" className="underline font-medium">Enter passwords →</a>
          </span>
          <button onClick={handleDismiss} className="ml-4 text-orange-500 hover:text-orange-700 text-sm">✕</button>
        </div>
      </div>
    );
  }

  if (job.status === "complete") {
    return (
      <div className="bg-green-50 border-b border-green-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-green-800 font-medium">
            Sync complete — {job.newTransactions} new transactions imported
          </span>
          <button onClick={handleDismiss} className="ml-4 text-green-500 hover:text-green-700 text-sm">✕</button>
        </div>
      </div>
    );
  }

  if (job.status === "failed") {
    return (
      <div className="bg-red-50 border-b border-red-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-red-800">
            Sync failed.{" "}
            <button onClick={async () => { await fetch("/api/gmail/sync/start", { method: "POST" }); tick(); }}
              className="underline font-medium">Retry</button>
          </span>
          <button onClick={handleDismiss} className="ml-4 text-red-500 hover:text-red-700 text-sm">✕</button>
        </div>
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 8.2: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 8.3: Commit**

```bash
git add src/components/SyncProgressBanner.tsx
git commit -m "feat(banner): 5s poll, drive advance endpoint client-side, add rate_limited state"
```

---

## Task 9: Fix Onboarding Page — Skip Preview + Wire Sync (20 min)

**Files:**
- Modify: `src/app/(app)/onboarding/page.tsx`

Key changes: (1) add "Skip preview" button that auto-approves all autoApproved senders, (2) wire the syncing step to drive the advance endpoint (same as the banner does), (3) check `gmailSyncedAt` on mount — if already set, redirect to dashboard (user shouldn't be here).

- [ ] **Step 9.1: Update onboarding/page.tsx**

```typescript
"use client";
import { useState, useEffect } from "react";
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

  // If user already synced, skip onboarding
  useEffect(() => {
    fetch("/api/gmail/sync/active")
      .then((r) => r.json())
      .then((data) => {
        if (data?.status === "complete") router.replace("/dashboard");
      })
      .catch(() => {});
  }, [router]);

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

  const handleSkipPreview = async () => {
    if (!scanResult) return;
    // Auto-approve all autoApproved senders, skip needsReview
    await handleConfirm(scanResult.autoApproved, []);
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

      const startRes = await fetch("/api/gmail/sync/start", { method: "POST" });
      if (!startRes.ok) {
        const errData = (await startRes.json()) as { error: string; jobId?: string; running?: boolean };
        if (errData.running && errData.jobId) {
          // Already running — resume with existing job
          setSyncJobId(errData.jobId);
          setStep("syncing");
          return;
        }
        throw new Error(errData.error ?? "Failed to start sync");
      }
      const { jobId } = (await startRes.json()) as { jobId: string };
      setSyncJobId(jobId);
      setStep("syncing");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStep("review");
    }
  };

  const stepNumber = step === "pick" ? 1 : step === "scanning" || step === "review" || step === "confirming" ? 2 : 3;

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
          <div>
            <StepReview result={scanResult} onConfirm={handleConfirm} loading={step === "confirming"} />
            <div className="mt-4 pt-4 border-t border-gray-100 flex justify-end">
              <button
                onClick={handleSkipPreview}
                disabled={step === "confirming"}
                className="text-sm text-gray-500 hover:text-gray-700 underline underline-offset-2 disabled:opacity-50"
              >
                Skip preview — sync everything
              </button>
            </div>
          </div>
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

- [ ] **Step 9.2: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 9.3: Commit**

```bash
git add src/app/(app)/onboarding/page.tsx
git commit -m "feat(onboarding): add Skip preview button, handle already-running job re-entry"
```

---

## Task 10: Add Sync Now + Last Synced to Settings Page (20 min)

**Files:**
- Modify: `src/app/(app)/settings/page.tsx`

Add: (1) a "Sync" section showing last synced time with a "Sync now" button, (2) the advance dev button should also work for client-driven calls (update URL to remove secret requirement for session auth).

- [ ] **Step 10.1: Add user info fetch and sync section to settings**

At the top of the `SettingsPage` component, add state and fetch for user info. Then add a new "Gmail Sync" section card.

Add to the state declarations (after `allCleared`):

```typescript
  /* ── Gmail Sync ── */
  const [gmailSyncedAt, setGmailSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
```

Add a `loadUserInfo` function and call it on mount:

```typescript
  const loadUserInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/user/info");
      if (!res.ok) return;
      const data = await res.json() as { gmailSyncedAt: string | null };
      setGmailSyncedAt(data.gmailSyncedAt);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadUserInfo(); }, [loadUserInfo]);
```

Add the `handleSyncNow` function:

```typescript
  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncMessage("");
    try {
      const res = await fetch("/api/gmail/sync/start", { method: "POST" });
      const data = await res.json() as { jobId?: string; error?: string; running?: boolean };
      if (data.running) {
        setSyncMessage("Sync already in progress — check the banner at the top.");
      } else if (data.jobId) {
        setSyncMessage("Sync started! Watch the banner at the top of the page.");
      } else {
        setSyncMessage(data.error ?? "Failed to start sync.");
      }
    } finally {
      setSyncing(false);
    }
  };
```

Add a "Gmail Sync" section card before the "Demo Data" section (before `{/* Demo Data */}`):

```tsx
      {/* Gmail Sync */}
      <div className="mt-8 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Gmail Sync</h3>
        {gmailSyncedAt ? (
          <p className="text-sm text-gray-500 mb-3">
            Last synced:{" "}
            <span className="text-gray-700 font-medium">
              {new Date(gmailSyncedAt).toLocaleString("en-IN", {
                day: "numeric", month: "short", year: "numeric",
                hour: "2-digit", minute: "2-digit",
              })}
            </span>
          </p>
        ) : (
          <p className="text-sm text-gray-400 mb-3">No sync completed yet.</p>
        )}
        <button
          onClick={handleSyncNow}
          disabled={syncing}
          className="px-4 py-2 text-sm bg-[#5b7cfa] text-white rounded-lg hover:bg-[#4a6be8] disabled:opacity-50 transition-colors"
        >
          {syncing ? "Starting…" : "Sync now"}
        </button>
        {syncMessage && <p className="text-xs text-gray-500 mt-2">{syncMessage}</p>}
      </div>
```

- [ ] **Step 10.2: Create /api/user/info route**

Create `src/app/api/user/info/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { gmailSyncedAt: true },
  });
  return NextResponse.json({ gmailSyncedAt: user?.gmailSyncedAt?.toISOString() ?? null });
}
```

- [ ] **Step 10.3: Run all tests**

```bash
npx jest --no-coverage 2>&1 | tail -10
```
Expected: PASS

- [ ] **Step 10.4: Commit**

```bash
git add src/app/(app)/settings/page.tsx src/app/api/user/info/route.ts
git commit -m "feat(settings): add Sync now button with last synced time"
```

---

## Task 11: Push and Verify Deploy (5 min)

- [ ] **Step 11.1: Run full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -20
```
Expected: All tests PASS

- [ ] **Step 11.2: Review the git log**

```bash
git log --oneline -10
```
Expected: Tasks 1–10 commits visible

- [ ] **Step 11.3: Push to main and verify Vercel deployment**

```bash
git push origin main
```
Then check the Vercel dashboard: the build should succeed. The cron job entry should show `0 2 * * *`.

---

## Success Criteria Checklist

Cross-reference with `docs/superpowers/specs/2026-07-12-gmail-sync-redesign.md`:

- [ ] `vercel.json` cron `0 2 * * *` — deployment succeeds on Hobby plan
- [ ] First-time user: period picker → sender preview → live progress bar
- [ ] "Skip preview" button auto-approves all senders and starts sync
- [ ] Live progress updates every 5s (not 15s)
- [ ] Gmail Batch API: 50 emails fetched in 1 HTTP call per tick
- [ ] Gemini: 1 call per tick for all 50 emails
- [ ] Rate limit banner appears when Gemini quota >= 1400/day
- [ ] `gmailSyncedAt` is set on job completion
- [ ] Incremental sync uses `gmailSyncedAt - 24h` as watermark
- [ ] Scan route paginates through all Gmail pages
- [ ] "Sync now" button in Settings triggers incremental sync
- [ ] "Delete all data" resets `gmailSyncedAt = null`, forces full resync from period picker
- [ ] All existing unit tests pass after each task
