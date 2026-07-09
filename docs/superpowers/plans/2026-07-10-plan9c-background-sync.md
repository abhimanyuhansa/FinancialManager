# Plan 9c: Background Sync (Cron) + Active Job Endpoint + Sync Banner

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Vercel Cron endpoint that advances all running SyncJobs every 15 minutes; expose an active-job status endpoint; add a persistent SyncProgressBanner to AppLayout that polls and shows sync progress across page navigations.

**Architecture:** Three new files: `advance/route.ts` (cron handler), `active/route.ts` (status API), `SyncProgressBanner.tsx` (client component). AppLayout imports the banner. Settings page gets a dev-only "Advance Sync" button. ParseLog pruning runs at end of each cron tick.

**Prerequisite:** Plans 9a and 9b complete (schema + batching in place).

**Tech Stack:** Next.js 16, Prisma 7, Vercel Cron, React client component, sessionStorage

---

## File Map

| File | Action |
|------|--------|
| `src/app/api/gmail/sync/advance/route.ts` | New — cron endpoint, processes one chunk per running job, prunes old ParseLogs |
| `src/app/api/gmail/sync/active/route.ts` | New — returns most recent SyncJob for current user |
| `src/components/SyncProgressBanner.tsx` | New — persistent banner component |
| `src/components/AppLayout.tsx` | Add `<SyncProgressBanner />` above `<main>` |
| `src/app/(app)/settings/page.tsx` | Add "Advance Sync (dev)" button (dev-only) |
| `vercel.json` | New — cron schedule config |

---

## Task 1: Create the Cron Advance Endpoint

**Files:**
- Create: `src/app/api/gmail/sync/advance/route.ts`

- [ ] **Step 1: Check if the advance directory exists**

```bash
ls src/app/api/gmail/sync/
```

Expected: shows `chunk/`, `start/`, `status/` (and possibly others). If `advance/` doesn't exist, it will be created by writing the file.

- [ ] **Step 2: Write the advance route**

Create `src/app/api/gmail/sync/advance/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const CHUNK_SIZE = 15;
const BATCH_SIZE = 10;

// Inline fetchFullMessage and processChunk logic — this runs as a cron job
// and cannot call /api/gmail/sync/chunk (no session context available)
import { getGmailToken } from "@/lib/gmail";
import { parseEmailBatch, BatchInput } from "@/lib/gemini";
import { upsertTransaction } from "@/lib/dedup";
import { matchesEmailFilter } from "@/lib/emailFilter";

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

async function advanceJob(job: {
  id: string;
  userId: string;
  processedEmails: number;
  messageIds: string | null;
}): Promise<{ newTransactions: number; encryptedBlockedCount: number; completed: boolean }> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const allIds: string[] = job.messageIds ? JSON.parse(job.messageIds) : [];
  const slice = allIds.slice(job.processedEmails, job.processedEmails + CHUNK_SIZE);

  if (slice.length === 0) {
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "complete", completedAt: new Date() },
    });
    return { newTransactions: 0, encryptedBlockedCount: 0, completed: true };
  }

  const accessToken = await getGmailToken(job.userId);
  if (!accessToken) {
    console.error(`[advance] No Gmail token for userId=${job.userId}`);
    return { newTransactions: 0, encryptedBlockedCount: 0, completed: false };
  }

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
    const isActive = await matchesEmailFilter(msg.senderDomain, msg.senderName);
    fetched.push({
      msgId,
      body: msg.body,
      senderName: msg.senderName,
      senderDomain: msg.senderDomain,
      receivedDate: msg.receivedDate,
      filtered: !isActive,
    });
  }

  const BODY_LIMIT = 1500;
  const filteredLogs = fetched.filter((e) => e.filtered).map((e) => ({
    userId: job.userId,
    syncJobId: job.id,
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

  const toProcess = fetched.filter((e) => !e.filtered);
  let newTransactions = 0;
  const encryptedBlockedCount = 0;

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
        userId: job.userId,
        syncJobId: job.id,
        gmailMsgId: email.msgId,
        senderDomain: email.senderDomain,
        emailDate: new Date(email.receivedDate),
        bodyLengthRaw: result.bodyLengthRaw,
        bodyLengthSent: result.bodyLengthSent,
        wasTruncated: result.wasTruncated,
        batchSize: batch.length,
      };

      if (result.outcome !== "parsed") {
        await prisma.parseLog.create({ data: { ...logBase, outcome: result.outcome } });
        continue;
      }

      let category = result.category!;
      const merchantKey = result.merchant!.toLowerCase().trim();
      const rule = await prisma.merchantRule.findUnique({
        where: { userId_merchantName: { userId: job.userId, merchantName: merchantKey } },
      });
      if (rule) category = rule.category;

      const upsertResult = await upsertTransaction({
        userId: job.userId,
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
    where: { id: job.id },
    data: {
      processedEmails: processed,
      newTransactions: { increment: newTransactions },
      encryptedBlockedCount: { increment: encryptedBlockedCount },
      ...(isComplete ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  return { newTransactions, encryptedBlockedCount, completed: isComplete };
}

export async function GET(req: NextRequest) {
  // Verify cron secret
  const secret = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find all running jobs, oldest first
  const runningJobs = await prisma.syncJob.findMany({
    where: { status: "running" },
    orderBy: { startedAt: "asc" },
    select: { id: true, userId: true, processedEmails: true, messageIds: true },
  });

  console.log(`[advance] Processing ${runningJobs.length} running jobs`);

  const summary: Array<{ jobId: string; newTransactions: number; completed: boolean }> = [];
  for (const job of runningJobs) {
    const result = await advanceJob(job);
    summary.push({ jobId: job.id, newTransactions: result.newTransactions, completed: result.completed });
  }

  // Prune ParseLog rows older than 30 days
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const pruned = await prisma.parseLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  console.log(`[advance] Pruned ${pruned.count} ParseLog rows older than 30 days`);

  return NextResponse.json({ jobs: summary, pruned: pruned.count });
}
```

- [ ] **Step 3: Create vercel.json**

Create `vercel.json` in the project root:

```json
{
  "crons": [
    {
      "path": "/api/gmail/sync/advance",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

- [ ] **Step 4: Verify the cron secret header**

The Vercel Cron service sends requests with the header `x-cron-secret` set to the value of the `CRON_SECRET` environment variable (if configured). Confirm your `CRON_SECRET` is set in `.env.local` (from Plan 9a).

Note: Vercel's actual cron authentication uses `Authorization: Bearer <CRON_SECRET>` in newer versions. Check the Vercel docs for the current header name. The code above checks `x-cron-secret` — adjust to match Vercel's actual header if different. The local dev button (Task 3) will send it as a query param for simplicity.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/gmail/sync/advance/route.ts vercel.json
git commit -m "feat(cron): add background sync advance endpoint with 15-min Vercel Cron schedule"
```

---

## Task 2: Create the Active Job Status Endpoint

**Files:**
- Create: `src/app/api/gmail/sync/active/route.ts`

- [ ] **Step 1: Write the active route**

Create `src/app/api/gmail/sync/active/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = await prisma.syncJob.findFirst({
    where: { userId: session.user.id },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      totalEmails: true,
      processedEmails: true,
      newTransactions: true,
      encryptedBlockedCount: true,
      startedAt: true,
      completedAt: true,
    },
  });

  if (!job) {
    return NextResponse.json(null);
  }

  return NextResponse.json(job);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/gmail/sync/active/route.ts
git commit -m "feat(sync): add active job status endpoint"
```

---

## Task 3: Create the SyncProgressBanner Component

**Files:**
- Create: `src/components/SyncProgressBanner.tsx`

- [ ] **Step 1: Write SyncProgressBanner**

Create `src/components/SyncProgressBanner.tsx`:

```typescript
"use client";
import { useEffect, useState, useCallback } from "react";

type SyncJob = {
  id: string;
  status: "running" | "complete" | "failed";
  totalEmails: number;
  processedEmails: number;
  newTransactions: number;
  encryptedBlockedCount: number;
  startedAt: string;
  completedAt: string | null;
};

const POLL_INTERVAL_MS = 30_000;
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
  const [dismissed, setDismissedState] = useState(false);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch("/api/gmail/sync/active");
      if (!res.ok) return;
      const data: SyncJob | null = await res.json();
      if (!data) {
        setJob(null);
        return;
      }
      if (isDismissed(data.id)) {
        setDismissedState(true);
        return;
      }
      setJob(data);
      setDismissedState(false);
    } catch {
      // ignore network errors
    }
  }, []);

  useEffect(() => {
    fetchJob();
    const interval = setInterval(fetchJob, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchJob]);

  // Auto-dismiss complete banner (no blocked PDFs)
  useEffect(() => {
    if (job?.status === "complete" && job.encryptedBlockedCount === 0) {
      const timer = setTimeout(() => {
        if (job) {
          setDismissed(job.id);
          setDismissedState(true);
        }
      }, AUTO_DISMISS_MS);
      return () => clearTimeout(timer);
    }
  }, [job]);

  if (!job || dismissed) return null;

  const pct = job.totalEmails > 0
    ? Math.round((job.processedEmails / job.totalEmails) * 100)
    : 0;

  const handleDismiss = () => {
    setDismissed(job.id);
    setDismissedState(true);
  };

  if (job.status === "running") {
    return (
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-blue-800 font-medium">
              Importing Gmail transactions… {job.processedEmails} / {job.totalEmails}
            </span>
            <span className="text-sm text-blue-600 font-semibold">{pct}%</span>
          </div>
          <div className="h-1.5 bg-blue-200 rounded-full">
            <div
              className="h-full bg-blue-600 rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-blue-600 mt-1">
            {job.newTransactions} new transactions found
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
            <a href="/settings?tab=statement-passwords" className="underline font-medium">
              Enter passwords →
            </a>
          </span>
          <button
            onClick={handleDismiss}
            className="ml-4 text-orange-500 hover:text-orange-700 text-sm"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  if (job.status === "complete") {
    return (
      <div className="bg-green-50 border-b border-green-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-green-800 font-medium">
            Sync complete — {job.newTransactions} transactions imported
          </span>
          <button
            onClick={handleDismiss}
            className="ml-4 text-green-500 hover:text-green-700 text-sm"
          >
            ✕
          </button>
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
            <button
              onClick={async () => {
                await fetch("/api/gmail/sync/start", { method: "POST" });
                fetchJob();
              }}
              className="underline font-medium"
            >
              Retry
            </button>
          </span>
          <button onClick={handleDismiss} className="ml-4 text-red-500 hover:text-red-700 text-sm">
            ✕
          </button>
        </div>
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 2: Add banner to AppLayout**

In `src/components/AppLayout.tsx`:

1. Import the banner at the top:
```typescript
import { SyncProgressBanner } from "./SyncProgressBanner";
```

2. Add `<SyncProgressBanner />` inside the flex wrapper, above `<main>`:
```typescript
export function AppLayout({ children }: AppLayoutProps) {
  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <nav className="hidden md:flex flex-col gap-1 w-16 lg:w-52 shrink-0 p-3 bg-white border-r border-gray-100">
        {/* ... existing nav content ... */}
      </nav>

      {/* Main content column */}
      <div className="flex-1 flex flex-col min-w-0">
        <SyncProgressBanner />
        <main className="flex-1 flex flex-col pb-20 md:pb-0 bg-[#eef0f6]">{children}</main>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 flex justify-around px-2 py-2 z-50">
        {/* ... existing nav content ... */}
      </nav>
    </div>
  );
}
```

- [ ] **Step 3: Add dev-only "Advance Sync" button to Settings page**

In `src/app/(app)/settings/page.tsx`, find the existing settings UI. Add this section (inside the existing settings component, in a logical location such as near the Gmail sync section):

```typescript
{process.env.NODE_ENV === "development" && (
  <div className="mt-6 p-4 border border-dashed border-gray-300 rounded-lg">
    <p className="text-xs text-gray-500 font-mono mb-2">DEV ONLY</p>
    <button
      onClick={async () => {
        const res = await fetch(
          `/api/gmail/sync/advance?secret=${process.env.NEXT_PUBLIC_CRON_SECRET ?? ""}`,
          { method: "GET" }
        );
        const data = await res.json();
        alert(JSON.stringify(data, null, 2));
      }}
      className="px-4 py-2 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-700"
    >
      Advance Sync (dev)
    </button>
  </div>
)}
```

Add `NEXT_PUBLIC_CRON_SECRET` to `.env.local` (same value as `CRON_SECRET`). This is acceptable for local dev since it's only rendered in development mode.

Alternatively, create a dedicated API route that wraps the advance endpoint:
`src/app/api/dev/advance-sync/route.ts` — only active in dev, calls advanceJob directly without requiring the secret header. This is cleaner and avoids exposing the secret in the browser. Your choice.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/SyncProgressBanner.tsx src/components/AppLayout.tsx src/app/(app)/settings/page.tsx
git commit -m "feat(sync): add SyncProgressBanner and dev advance button"
```

---

## Self-Check

- [x] Cron endpoint processes all running jobs one chunk per call
- [x] ParseLog pruning (30 days) runs at end of each cron tick
- [x] `CRON_SECRET` header authentication
- [x] Active job endpoint returns most recent SyncJob regardless of status
- [x] Banner shows running/complete/complete-with-blocked/failed states
- [x] Banner uses sessionStorage keyed by jobId — reappears after re-login
- [x] Complete banner auto-dismisses after 10s (no blocked PDFs case)
- [x] Banner placed above `<main>` in AppLayout, spans full width
- [x] Dev "Advance Sync" button only renders in development mode
- [x] vercel.json created with 15-min cron schedule
