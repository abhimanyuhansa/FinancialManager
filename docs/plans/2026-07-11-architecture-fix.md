# Architecture Fix Plan — Financial Manager POC
**Date:** 2026-07-11  
**Status:** Ready for implementation  
**Prerequisite reading:** Audit report delivered in conversation on 2026-07-11  

---

## Ground Rules for Implementing Agents

1. **Do not push to remote** without user confirmation.
2. **Run `npx tsc --noEmit` after every task** to verify no TypeScript regressions.
3. **Run `npm test` after every task** — tests must pass before marking complete.
4. **One commit per task** with the commit message format specified in each task.
5. **Read the AGENTS.md note:** This is Next.js 16. Read `node_modules/next/dist/docs/` if unsure about any Next.js API before writing code.
6. All tasks are **ordered by dependency** — implement in the sequence listed. Tasks within the same group (same letter prefix) are independent and can be parallelized.
7. File paths are relative to the project root: `/Users/i575379/Desktop/Repositories/POC/FinancialManager/`

---

## Overview of Issues Being Fixed

| # | Issue | Severity | Tasks |
|---|---|---|---|
| 1 | Dual cron conflict — Vercel cron rejected with 401, GH Actions unreliable | Critical | A1, A2 |
| 2 | Scanning phase never completes — loops all Gmail pages in one serverless call, will timeout | Critical | B1, B2, B3 |
| 3 | EmailFilter match bug — `senderName` passed instead of `senderEmail`, domain filters never match | Critical | C1 |
| 4 | Gmail query fetches all mail — no upfront categorical filter, causes 20K–40K message count | Critical | D1, D2 |
| 5 | Dual sync paths — `chunk/route.ts` duplicates `advance/route.ts`, race condition possible | High | E1 |
| 6 | `messageIds` JSON column — 200KB+ blob in single row, no resumability | High | F1, F2 |
| 7 | `MerchantRule` N+1 query — one DB lookup per parsed transaction in a loop | Medium | G1 |
| 8 | Banner poll too aggressive — 30s interval is fine; client chunk polling was 5s | Medium | E1 (covered) |

---

## Task A — Fix Cron Authentication (the cron is broken)

### A1 — Delete GitHub Actions cron, keep Vercel Cron only

**Why:** GitHub Actions `schedule:` is unreliable (deprioritized, delays up to 60 min, disabled after 60 days of inactivity), consumes free-tier Action minutes, and has authentication that duplicates Vercel Cron. Vercel Cron is the correct mechanism for Next.js on Vercel.

**Files to change:**
- Delete: `.github/workflows/sync-advance.yml`
- Verify: `vercel.json` already has the cron configured (it does — confirmed in audit)

**Steps:**

```bash
# Step 1: Remove the GitHub Actions workflow file
rm .github/workflows/sync-advance.yml

# Step 2: Verify vercel.json has correct cron config (should already be present)
cat vercel.json
# Expected output:
# {
#   "buildCommand": "npx prisma generate && next build",
#   "crons": [
#     {
#       "path": "/api/gmail/sync/advance",
#       "schedule": "*/15 * * * *"
#     }
#   ]
# }
```

If `vercel.json` does not have the `crons` key, add it. The final `vercel.json` must be:

```json
{
  "buildCommand": "npx prisma generate && next build",
  "crons": [
    {
      "path": "/api/gmail/sync/advance",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

**Commit:**
```bash
git rm .github/workflows/sync-advance.yml
git add vercel.json
git commit -m "fix(cron): remove GitHub Actions cron; Vercel Cron is sole scheduler"
```

---

### A2 — Fix cron authentication to match how Vercel Cron actually works

**Why:** The current code checks `x-cron-secret` header. Vercel Cron does NOT send this header. Vercel sends `Authorization: Bearer <CRON_SECRET>` where `CRON_SECRET` is the value set in your Vercel project environment variables as `CRON_SECRET`. 

**Important:** Vercel Cron's actual behavior: when `CRON_SECRET` is set in the Vercel project env vars, Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` with every cron invocation. The `x-cron-secret` pattern was a community workaround for older Vercel versions — it no longer works.

**File to change:** `src/app/api/gmail/sync/advance/route.ts`

**Change:** Update the `GET` handler's auth check at the top of the function. Find this block:

```typescript
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
```

Replace with:

```typescript
export async function GET(req: NextRequest) {
  // Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
  // Local dev button sends: ?secret=<CRON_SECRET> query param
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const querySecret = req.nextUrl.searchParams.get("secret");
  const provided = bearerToken ?? querySecret;

  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
```

**Also update `src/lib/auth.config.ts`** — the middleware already bypasses auth for this path, which is correct. No change needed there.

**Also update the dev "Advance Sync" button in `src/app/(app)/settings/page.tsx`** — the existing button passes `?secret=...` as a query param, which still works with the new code. No change needed there.

**Commit:**
```bash
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "fix(cron): use Authorization Bearer header for Vercel Cron auth"
```

---

## Task B — Fix the Scanning Phase (the scan always times out)

The current design runs the entire Gmail metadata scan in a single serverless call. For a user with 6 months of email — even after applying the Gmail query filter from Task D — there can be 1,000–5,000 qualifying messages. Fetching metadata for each in batches of 20 takes minutes, well beyond Vercel's 10-second free-tier limit.

**Solution:** Break the scan into pages. Store the Gmail `nextPageToken` in `SyncJob`. Each cron tick processes one page of the scan, then advances one chunk of emails. This keeps every cron invocation well under 10 seconds.

### B1 — Add `scanPageToken` and `gmailQuery` columns to `SyncJob`

**Why `gmailQuery`:** Store the Gmail query string used for this job so the cron can resume scanning with the exact same query, even if filters change mid-job.

**File to change:** `prisma/schema.prisma`

Find the `SyncJob` model and add two fields:

```prisma
model SyncJob {
  id                    String    @id @default(cuid())
  userId                String
  status                String    @default("running")
  totalEmails           Int       @default(0)
  processedEmails       Int       @default(0)
  newTransactions       Int       @default(0)
  skippedEmails         Int       @default(0)
  encryptedBlockedCount Int       @default(0)
  isRetrigger           Boolean   @default(false)
  startedAt             DateTime  @default(now())
  completedAt           DateTime?
  messageIds            String?
  scanPageToken         String?   // Gmail nextPageToken — null means scan complete or not started
  gmailQuery            String?   // the Gmail q= string used for this job
  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**Create migration:**
```bash
npx prisma migrate dev --name add_syncjob_scan_pagination
```

**Commit:**
```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): add scanPageToken and gmailQuery to SyncJob for paginated scanning"
```

---

### B2 — Refactor `sync/start` to store the Gmail query but NOT scan

**Why:** `sync/start` must return in under 1 second (it's called from the UI). It should only create the job and store the query. The actual scanning happens in the cron.

**File to change:** `src/app/api/gmail/sync/start/route.ts`

The new `start` route must:
1. Check for existing running/scanning job (same as now)
2. Verify Gmail token exists (same as now)
3. Build the Gmail query string (new — use the pre-filter query builder from Task D)
4. Create `SyncJob` with `status: "scanning"`, `gmailQuery: <query>`, `scanPageToken: null`
5. Return `{ jobId }` immediately

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { buildGmailQuery } from "@/lib/gmailQuery"; // new file — Task D1

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const existingJob = await prisma.syncJob.findFirst({
    where: { userId, status: { in: ["scanning", "running"] } },
    select: { id: true, processedEmails: true, totalEmails: true },
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
    select: { syncFromDate: true },
  });

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const syncFromDate = user?.syncFromDate ?? sixMonthsAgo;

  // Build the pre-filter query — dramatically reduces email count before individual fetches
  const gmailQuery = buildGmailQuery(syncFromDate);

  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: 0,
      messageIds: null,
      status: "scanning",
      gmailQuery,
      scanPageToken: null,
    },
  });

  console.log(`[sync/start] SyncJob created: jobId=${job.id} query="${gmailQuery}"`);
  return NextResponse.json({ jobId: job.id });
}
```

**Commit:**
```bash
git add src/app/api/gmail/sync/start/route.ts
git commit -m "fix(sync/start): store gmailQuery only; defer scanning to cron"
```

---

### B3 — Refactor the scanning phase in `advance/route.ts` to process one page per cron tick

**Why:** One page = up to 500 message refs + up to 500 metadata fetches = fits in 10 seconds only with the pre-filter query (which reduces the list to 50–200 messages per page, not 500). The cron processes one scan page, accumulates IDs into `messageIds`, then on the same tick (or next tick) advances one processing chunk.

**File to change:** `src/app/api/gmail/sync/advance/route.ts`

Replace the entire scanning section. The new logic for handling `scanning` jobs is:

```typescript
// Inside GET handler, replace the scanning jobs block:

const scanningJobs = await prisma.syncJob.findMany({
  where: { status: "scanning" },
  select: { id: true, userId: true, gmailQuery: true, scanPageToken: true, messageIds: true },
});

for (const job of scanningJobs) {
  console.log(`[advance] Scan page for jobId=${job.id} pageToken=${job.scanPageToken ?? "start"}`);

  const accessToken = await getGmailToken(job.userId);
  if (!accessToken) {
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "failed", completedAt: new Date() },
    });
    continue;
  }

  // Fetch one page of message refs (list call only — no individual metadata fetches)
  const page = await fetchMessageIdPage(
    accessToken,
    job.gmailQuery ?? "",
    job.scanPageToken ?? undefined
  );

  // Accumulate IDs
  const existingIds: string[] = job.messageIds ? JSON.parse(job.messageIds) : [];
  const allIds = [...existingIds, ...page.messageIds];

  const hasMorePages = !!page.nextPageToken;

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      messageIds: JSON.stringify(allIds),
      totalEmails: allIds.length,
      // If no more pages: flip to "running" so next tick starts processing
      // Keep scanPageToken so we know where we are; null means scan done
      scanPageToken: page.nextPageToken ?? null,
      status: hasMorePages ? "scanning" : "running",
    },
  });

  console.log(
    `[advance] jobId=${job.id} scan page done: +${page.messageIds.length} ids, total=${allIds.length}, hasMore=${hasMorePages}`
  );
}
```

**New function to add to `src/lib/gmail.ts`:**

```typescript
// Fetches only message IDs for one page — no individual metadata calls
export async function fetchMessageIdPage(
  accessToken: string,
  query: string,
  pageToken?: string
): Promise<{ messageIds: string[]; nextPageToken?: string }> {
  const params = new URLSearchParams({ maxResults: "500", q: query });
  if (pageToken) params.set("pageToken", pageToken);

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error(`[gmail] fetchMessageIdPage failed: ${res.status}`, err);
    throw new Error(`Gmail list failed: ${res.status}`);
  }

  const data = await res.json() as {
    messages?: Array<{ id: string }>;
    nextPageToken?: string;
  };

  return {
    messageIds: (data.messages ?? []).map((m) => m.id),
    nextPageToken: data.nextPageToken,
  };
}
```

**Key difference from old approach:** `fetchMessageIdPage` makes exactly ONE Gmail API call (the list call). It does NOT fetch individual message metadata. The metadata (From, Subject, Date) is fetched only when the message is actually processed in `advanceJob`, at which point the full message body is fetched anyway. This is more efficient and safe from timeout.

**The old `fetchMessageMetadataList` function** is still needed by `scan/route.ts` (the onboarding dry-run scan, which DOES need From/Subject for the sender classification UI). Do NOT remove it.

**Commit:**
```bash
git add src/app/api/gmail/sync/advance/route.ts src/lib/gmail.ts
git commit -m "fix(advance): paginate Gmail scan — one page per cron tick, no timeout risk"
```

---

## Task C — Fix the EmailFilter Match Bug (domain filters never match)

### C1 — Pass `senderEmail` (not `senderName`) to `matchesEmailFilter`

**Why:** `matchesEmailFilter` for `sender_domain` type splits `email.from` on `@` to extract the domain. The code currently passes `msg.senderName` (display name like `"HDFC Bank"`) which has no `@`, so domain is always `""` and the filter never matches. Silent data loss.

**Files to change:** 
- `src/app/api/gmail/sync/advance/route.ts`  
- `src/app/api/gmail/sync/chunk/route.ts`

**In `fetchFullMessage` in both files**, `senderEmail` is already extracted:
```typescript
const emailMatch = senderRaw.match(/<([^>]+)>/);
const senderEmail = emailMatch ? emailMatch[1] : senderRaw;
```

But it is not returned from `fetchFullMessage`. Add `senderEmail` to the return type and return value.

**Step 1 — Update the `FetchedMessage` type in both files:**

```typescript
type FetchedMessage = {
  body: string;
  senderName: string;
  senderEmail: string;    // ADD THIS
  senderDomain: string;
  receivedDate: string;
  hasPdfAttachment: boolean;
  pdfOutcome: "ok" | "encrypted" | "failed" | null;
};
```

**Step 2 — Return `senderEmail` from `fetchFullMessage` in both files:**

Find the return statement at the bottom of `fetchFullMessage`:
```typescript
return { body, senderName, senderDomain, receivedDate, hasPdfAttachment, pdfOutcome };
```
Change to:
```typescript
return { body, senderName, senderEmail, senderDomain, receivedDate, hasPdfAttachment, pdfOutcome };
```

**Step 3 — Update the `matchesEmailFilter` call in both files:**

Find:
```typescript
const filterResult = matchesEmailFilter({ from: msg.senderName, subject: "" }, filters);
```
Change to:
```typescript
const filterResult = matchesEmailFilter({ from: msg.senderEmail, subject: "" }, filters);
```

**Step 4 — Update the `FetchedEmail` intermediate type in both files** to carry `senderEmail`:

```typescript
type FetchedEmail = {
  msgId: string;
  body: string;
  senderName: string;
  senderEmail: string;    // ADD THIS
  senderDomain: string;
  receivedDate: string;
  filtered: boolean;
  sourceRank: number;
};
```

And when pushing to `fetched`, include `senderEmail: msg.senderEmail`.

**Commit:**
```bash
git add src/app/api/gmail/sync/advance/route.ts src/app/api/gmail/sync/chunk/route.ts
git commit -m "fix(sync): pass senderEmail to matchesEmailFilter — domain filters now match correctly"
```

---

## Task D — Gmail Pre-Filter Query (reduce 40K emails to ~500–2000)

This is the most impactful change for performance and cost. Instead of fetching all emails and filtering client-side, pass a narrowing Gmail search query upfront that eliminates ~95% of non-financial emails before any processing begins.

### D1 — Create `src/lib/gmailQuery.ts`

**New file:** `src/lib/gmailQuery.ts`

```typescript
/**
 * Builds a Gmail search query that pre-filters to financial emails only.
 *
 * Strategy:
 * 1. Exclude Gmail's built-in "Promotions" and "Forums" categories — these
 *    account for 60-80% of email volume and contain almost no financial emails.
 * 2. Apply a union of financial keywords that match transaction emails across
 *    all major Indian and international banks, payment apps, and merchants.
 * 3. Apply a date lower bound using the user's syncFromDate.
 *
 * This query typically reduces 20K–40K emails to 500–3000 without losing
 * any real transaction emails, because banks/payment apps send to Primary inbox.
 *
 * Example output for 6-month lookback:
 *   after:1720656000 -category:promotions -category:forums
 *   (subject:(statement OR transaction OR payment OR invoice OR receipt OR
 *    order OR purchase OR refund OR debit OR credit OR debited OR credited OR
 *    charged OR transferred OR OTP OR UPI OR NEFT OR IMPS OR RTGS)
 *    OR from:(bank OR pay OR card OR wallet OR finance OR money))
 */
export function buildGmailQuery(syncFromDate: Date): string {
  const afterSeconds = Math.floor(syncFromDate.getTime() / 1000);

  const subjectKeywords = [
    "statement",
    "transaction",
    "payment",
    "invoice",
    "receipt",
    "order",
    "purchase",
    "refund",
    "debit",
    "credit",
    "debited",
    "credited",
    "charged",
    "transferred",
    "OTP",
    "UPI",
    "NEFT",
    "IMPS",
    "RTGS",
    "EMI",
    "mandate",
    "autopay",
    "subscription",
  ];

  const fromKeywords = [
    "bank",
    "pay",
    "card",
    "wallet",
    "finance",
    "money",
    "credit",
    "noreply",
    "alerts",
    "notify",
    "notification",
  ];

  const subjectClause = `subject:(${subjectKeywords.join(" OR ")})`;
  const fromClause = `from:(${fromKeywords.join(" OR ")})`;

  return [
    `after:${afterSeconds}`,
    `-category:promotions`,
    `-category:forums`,
    `(${subjectClause} OR ${fromClause})`,
  ].join(" ");
}
```

**Commit:**
```bash
git add src/lib/gmailQuery.ts
git commit -m "feat(gmail): add buildGmailQuery pre-filter to reduce scan volume by ~95%"
```

---

### D2 — Apply the pre-filter query to the onboarding scan route too

**Why:** `scan/route.ts` (onboarding dry-run) currently fetches ALL emails then classifies them client-side. With 40K emails this times out. Apply the same query upfront.

**File to change:** `src/app/api/gmail/scan/route.ts`

Add the import:
```typescript
import { buildGmailQuery } from "@/lib/gmailQuery";
```

Replace `fetchMessageMetadataList` usage to use the pre-filter query. The current code:

```typescript
const fromDate = buildScanFromDate(period);
const allMessages = [];
let pageToken: string | undefined;
do {
  const page = await fetchMessageMetadataList(accessToken, fromDate, pageToken);
  allMessages.push(...page.messages);
  pageToken = page.nextPageToken;
} while (pageToken);
```

**Problem:** Even with the query, this do-while loop can timeout if many pages. But the scan route is called once synchronously from the browser, not from cron. It can be up to ~60 seconds on Vercel Pro, but on free tier it's 10 seconds.

**Fix:** Make the scan route also paginated. Return partial results after one page and a `scanToken` the client can use to request the next page. However, this requires frontend changes. 

**Simpler fix for now:** Apply the query filter so the total message count drops from 40K to ~2K, making a single-page scan feasible for most users. For the rare case of a user who gets 2K+ financial emails in 6 months, the scan will still return partial results (just fewer sender suggestions), which is acceptable. Change to:

```typescript
import { buildGmailQuery } from "@/lib/gmailQuery";

// ... inside POST handler, replace the do-while:

const gmailQuery = buildGmailQuery(fromDate);
console.log(`[scan] gmailQuery="${gmailQuery}"`);

// Single-page scan — returns up to 500 messages after filtering.
// For most users this covers the full 6-month financial email set.
// The pre-filter query reduces 40K emails to ~500-2000 before the API call.
const page = await fetchMessageMetadataList(accessToken, fromDate, undefined, gmailQuery);
const allMessages = page.messages;
console.log(`[scan] fetched ${allMessages.length} messages after pre-filter`);
```

**Update `fetchMessageMetadataList` in `src/lib/gmail.ts`** to accept an optional `query` parameter:

```typescript
export async function fetchMessageMetadataList(
  accessToken: string,
  afterDate: Date,
  pageToken?: string,
  query?: string          // ADD: optional override query (used by scan route)
): Promise<{ messages: EmailMeta[]; nextPageToken?: string }> {
  const afterSeconds = Math.floor(afterDate.getTime() / 1000);
  const params = new URLSearchParams({
    maxResults: "500",
    q: query ?? `after:${afterSeconds}`,  // use provided query or fallback to date-only
  });
  // ... rest of function unchanged
```

**Commit:**
```bash
git add src/app/api/gmail/scan/route.ts src/lib/gmail.ts
git commit -m "fix(scan): apply pre-filter Gmail query in onboarding scan — handles large mailboxes"
```

---

## Task E — Eliminate the Dual Sync Path (remove `chunk/route.ts`)

### E1 — Remove client-driven chunk processing; client polls only

**Why:** Having both `chunk/route.ts` (client drives processing) and `advance/route.ts` (cron drives processing) is dangerous: if both run simultaneously on the same job, `processedEmails` is read at the same offset by two callers, and the same 15 emails get processed twice. The cron is the source of truth. The client should only poll for status.

**Files to change:**
- Delete: `src/app/api/gmail/sync/chunk/route.ts` — remove the HTTP endpoint entirely. The processing logic stays in `advance/route.ts`.
- Update: Any frontend component that calls `POST /api/gmail/sync/chunk` — replace with pure status polling.

**Step 1 — Find all callers of `/api/gmail/sync/chunk`:**

```bash
grep -r "sync/chunk" src/ --include="*.ts" --include="*.tsx"
```

For each caller:
- If it was calling `POST /api/gmail/sync/chunk` in a polling loop: replace the loop with just `GET /api/gmail/sync/active` polling every 15 seconds.
- The `SyncProgressBanner` already polls `active` — no change needed there.

**Step 2 — Update the onboarding page** (`src/app/(app)/onboarding/page.tsx`):

The onboarding page likely calls `/api/gmail/sync/start` then polls `/api/gmail/sync/chunk`. Change to:
1. Call `POST /api/gmail/sync/start` → get `jobId`
2. Poll `GET /api/gmail/sync/active` every 15 seconds
3. Show progress from `active` response (the `SyncProgressBanner` in AppLayout already does this — onboarding can just navigate to dashboard and let the banner handle it)

**Step 3 — Delete `chunk/route.ts`:**

```bash
rm src/app/api/gmail/sync/chunk/route.ts
```

**Commit:**
```bash
git add -A
git commit -m "fix(sync): remove chunk route — cron is sole processor; client polls active endpoint only"
```

---

## Task F — Replace `messageIds` JSON Blob with a Proper Table

**Why:** Storing thousands of message IDs as a JSON string in a single column causes:
1. Every cron tick reads and deserializes the entire array just to slice 15 IDs
2. Row size can reach 200KB+ for large mailboxes
3. No way to query "which IDs are unprocessed" — purely offset-based
4. If job is cancelled mid-way, offset may be wrong after restart

### F1 — Add `SyncJobMessage` table to schema

**File to change:** `prisma/schema.prisma`

Add the new model and remove `messageIds` from `SyncJob`:

```prisma
model SyncJob {
  id                    String           @id @default(cuid())
  userId                String
  status                String           @default("running")
  totalEmails           Int              @default(0)
  processedEmails       Int              @default(0)
  newTransactions       Int              @default(0)
  skippedEmails         Int              @default(0)
  encryptedBlockedCount Int              @default(0)
  isRetrigger           Boolean          @default(false)
  startedAt             DateTime         @default(now())
  completedAt           DateTime?
  scanPageToken         String?
  gmailQuery            String?
  // messageIds column REMOVED
  messages              SyncJobMessage[]
  user                  User             @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model SyncJobMessage {
  id         String  @id @default(cuid())
  syncJobId  String
  gmailMsgId String
  processed  Boolean @default(false)
  syncJob    SyncJob @relation(fields: [syncJobId], references: [id], onDelete: Cascade)

  @@unique([syncJobId, gmailMsgId])
  @@index([syncJobId, processed])   // critical for "get next N unprocessed" query
}
```

**Create migration:**
```bash
npx prisma migrate dev --name add_syncjobmessage_table
```

**Important:** The migration needs to handle data for any existing jobs. Add this to the migration SQL (after the generated SQL):

```sql
-- Migrate existing messageIds JSON to SyncJobMessage rows
INSERT INTO "SyncJobMessage" ("id", "syncJobId", "gmailMsgId", "processed")
SELECT
  gen_random_uuid()::text,
  "id",
  jsonb_array_elements_text("messageIds"::jsonb),
  false
FROM "SyncJob"
WHERE "messageIds" IS NOT NULL AND "status" IN ('scanning', 'running');
```

After verifying migration is correct:
```bash
npx prisma migrate dev --name add_syncjobmessage_table
```

**Commit:**
```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): replace messageIds JSON blob with SyncJobMessage table"
```

---

### F2 — Update `advance/route.ts` to use `SyncJobMessage` table

**File to change:** `src/app/api/gmail/sync/advance/route.ts`

**Replace the scanning phase** (already partially updated in B3). When scan page is fetched, instead of appending to `messageIds` JSON, insert rows into `SyncJobMessage`:

```typescript
// After fetching page.messageIds in the scanning loop:
if (page.messageIds.length > 0) {
  await prisma.syncJobMessage.createMany({
    data: page.messageIds.map((id) => ({
      syncJobId: job.id,
      gmailMsgId: id,
      processed: false,
    })),
    skipDuplicates: true,
  });
}

const totalCount = await prisma.syncJobMessage.count({
  where: { syncJobId: job.id },
});

await prisma.syncJob.update({
  where: { id: job.id },
  data: {
    totalEmails: totalCount,
    scanPageToken: page.nextPageToken ?? null,
    status: page.nextPageToken ? "scanning" : "running",
  },
});
```

**Replace `advanceJob`** to fetch the next N unprocessed message IDs from the table instead of slicing the JSON array:

```typescript
async function advanceJob(job: { id: string; userId: string }): Promise<{
  newTransactions: number;
  encryptedBlockedCount: number;
  completed: boolean;
}> {
  // Fetch next N unprocessed IDs
  const pending = await prisma.syncJobMessage.findMany({
    where: { syncJobId: job.id, processed: false },
    take: CHUNK_SIZE,
    orderBy: { id: "asc" },   // stable ordering
    select: { id: true, gmailMsgId: true },
  });

  if (pending.length === 0) {
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

  // ... (rest of message fetching and processing — same as current advanceJob)
  // At the end, mark processed rows as done:
  await prisma.syncJobMessage.updateMany({
    where: { id: { in: pending.map((p) => p.id) } },
    data: { processed: true },
  });

  // Update SyncJob counters
  const totalRemaining = await prisma.syncJobMessage.count({
    where: { syncJobId: job.id, processed: false },
  });
  const isComplete = totalRemaining === 0;
  const processedCount = await prisma.syncJobMessage.count({
    where: { syncJobId: job.id, processed: true },
  });

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      processedEmails: processedCount,
      newTransactions: { increment: newTransactions },
      encryptedBlockedCount: { increment: encryptedBlockedCount },
      ...(isComplete ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  return { newTransactions, encryptedBlockedCount, completed: isComplete };
}
```

**Remove** the `processedEmails` offset logic entirely — it's replaced by the `processed: false` query.

**Commit:**
```bash
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "fix(advance): use SyncJobMessage table instead of messageIds JSON for resumable processing"
```

---

## Task G — Fix N+1 MerchantRule Query

### G1 — Batch-fetch all MerchantRules at the start of `advanceJob`

**Why:** Current code does `prisma.merchantRule.findUnique(...)` inside the processing loop — once per transaction. For a 15-email chunk that produces 10 transactions, that's 10 sequential DB round trips.

**File to change:** `src/app/api/gmail/sync/advance/route.ts`

At the top of `advanceJob` (after getting the access token), add:

```typescript
// Fetch all merchant rules for this user once, build lookup map
const merchantRules = await prisma.merchantRule.findMany({
  where: { userId: job.userId },
  select: { merchantName: true, category: true },
});
const merchantRuleMap = new Map(merchantRules.map((r) => [r.merchantName, r.category]));
```

Then replace the per-transaction lookup:

```typescript
// REMOVE:
const rule = await prisma.merchantRule.findUnique({
  where: { userId_merchantName: { userId: job.userId, merchantName: merchantKey } },
});
if (rule) category = rule.category;

// REPLACE WITH:
const overrideCategory = merchantRuleMap.get(merchantKey);
if (overrideCategory) category = overrideCategory;
```

**Commit:**
```bash
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "perf(advance): batch-fetch MerchantRules once per job — eliminates N+1 DB queries"
```

---

## Task H — Update `SyncProgressBanner` Poll Interval and Scanning State UX

**Why:** The banner currently shows "Importing Gmail transactions…" during both `scanning` and `running` states. Users have no idea what scanning means. Poll interval should be 15s during active sync (not too aggressive for free tier) and fall back to 60s when complete.

**File to change:** `src/components/SyncProgressBanner.tsx`

**Change 1 — Poll interval:**

```typescript
const POLL_INTERVAL_RUNNING_MS = 15_000;   // 15s while scanning/running
const POLL_INTERVAL_IDLE_MS = 60_000;      // 60s when complete/failed (dismiss pending)
```

Update the polling logic in `useEffect` to use the right interval based on job status.

**Change 2 — Scanning state copy:**

In the `job.status === "running"` render block (keep same), also handle `"scanning"`:

```typescript
if (job.status === "scanning") {
  return (
    <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-2">
          {/* spinner */}
          <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-blue-800 font-medium">
            Scanning your Gmail for financial emails…
          </span>
        </div>
        <p className="text-xs text-blue-600 mt-1">
          This runs in the background — you can navigate freely
        </p>
      </div>
    </div>
  );
}
```

**Commit:**
```bash
git add src/components/SyncProgressBanner.tsx
git commit -m "fix(banner): add scanning state UI; tune poll intervals for free-tier safety"
```

---

## Task I — Verification & Smoke Tests

After all tasks above are complete, verify end-to-end:

### I1 — TypeScript

```bash
npx tsc --noEmit
```
Expected: zero errors.

### I2 — Unit tests

```bash
npm test
```
Expected: all pass.

### I3 — Manual verification checklist

```
[ ] vercel.json has "crons" with /api/gmail/sync/advance at */15
[ ] .github/workflows/sync-advance.yml is deleted
[ ] GET /api/gmail/sync/advance returns 401 with no auth header
[ ] GET /api/gmail/sync/advance returns 200 with Authorization: Bearer <CRON_SECRET>
[ ] POST /api/gmail/sync/start returns { jobId } immediately (< 500ms)
[ ] SyncJob created with status="scanning", gmailQuery set, scanPageToken=null
[ ] After one cron tick: SyncJob has SyncJobMessage rows, totalEmails updated
[ ] After two cron ticks: some SyncJobMessage rows have processed=true
[ ] SyncProgressBanner shows "Scanning your Gmail..." during scanning state
[ ] SyncProgressBanner shows progress bar during running state
[ ] matchesEmailFilter called with senderEmail — domains like "hdfcbank.com" match correctly
[ ] No more "skipped_filter" ParseLog entries for known financial senders
[ ] chunk/route.ts does not exist
[ ] No frontend component calls /api/gmail/sync/chunk
```

### I4 — Environment variables required in Vercel dashboard

Ensure these are set in Vercel project environment variables (Settings → Environment Variables):

```
CRON_SECRET              = <any random 32-char string>
GEMINI_API_KEY           = <your Gemini API key>
GOOGLE_CLIENT_ID         = <from Google Cloud Console>
GOOGLE_CLIENT_SECRET     = <from Google Cloud Console>
DATABASE_URL             = <Neon connection string>
NEXTAUTH_SECRET          = <any random 32-char string>
STATEMENT_ENCRYPTION_KEY = <64 hex chars = 32 random bytes>
```

`CRON_SECRET` must match the value the cron auth check reads. After deploying, Vercel Cron will automatically call `/api/gmail/sync/advance` with `Authorization: Bearer <CRON_SECRET>` every 15 minutes.

---

## Summary of File Changes

| File | Action | Tasks |
|---|---|---|
| `.github/workflows/sync-advance.yml` | **DELETE** | A1 |
| `vercel.json` | Verify/ensure `crons` key present | A1 |
| `src/app/api/gmail/sync/advance/route.ts` | Auth fix + paginated scan + SyncJobMessage | A2, B3, F2 |
| `src/app/api/gmail/sync/start/route.ts` | Store gmailQuery, defer scan to cron | B2 |
| `src/app/api/gmail/sync/chunk/route.ts` | **DELETE** | E1 |
| `src/lib/gmail.ts` | Add `fetchMessageIdPage`; update `fetchMessageMetadataList` signature | B3, D2 |
| `src/lib/gmailQuery.ts` | **CREATE** — pre-filter query builder | D1 |
| `src/lib/emailFilter.ts` | No change needed | — |
| `prisma/schema.prisma` | Add `scanPageToken`, `gmailQuery` to SyncJob; add `SyncJobMessage` model; remove `messageIds` | B1, F1 |
| `prisma/migrations/` | Two new migrations | B1, F1 |
| `src/components/SyncProgressBanner.tsx` | Scanning state UI, poll interval tuning | H |
| `src/app/(app)/onboarding/page.tsx` | Remove chunk polling, use active polling | E1 |

---

## Architecture After Fix

```
User clicks "Sync Gmail"
        │
        ▼
POST /api/gmail/sync/start
  → validates token
  → buildGmailQuery(syncFromDate)     ← pre-filters 40K→500 emails
  → creates SyncJob { status:"scanning", gmailQuery, scanPageToken:null }
  → returns { jobId } immediately

Vercel Cron fires every 15 min
  → GET /api/gmail/sync/advance
  → Authorization: Bearer <CRON_SECRET>   ← now works
  │
  ├─ For each "scanning" job:
  │    fetchMessageIdPage(gmailQuery, scanPageToken)  ← 1 API call, ~50ms
  │    SyncJobMessage.createMany(page.messageIds)
  │    if no nextPageToken: SyncJob.status = "running"
  │    else: SyncJob.scanPageToken = nextPageToken (continue next tick)
  │
  └─ For each "running" job:
       SyncJobMessage.findMany({ processed:false }, take:15)
       for each message: fetchFullMessage → filterCheck → Gemini batch
       SyncJobMessage.updateMany({ processed:true })
       SyncJob.processedEmails++, newTransactions++

Client (SyncProgressBanner)
  → polls GET /api/gmail/sync/active every 15s
  → shows "Scanning..." or "Importing X/Y" or "Complete"
  → zero client-driven processing calls
```

---

## Cost Model After Fix (10 users)

| Resource | Free Limit | Usage After Fix | Status |
|---|---|---|---|
| Vercel cron invocations | 100K/month | 2,880/month (4×24×30) | ✅ |
| Vercel function runtime | 100 GB-hr/month | < 1 GB-hr | ✅ |
| Vercel invocations (UI) | 100K/month | ~5K normal browsing | ✅ |
| Neon storage | 0.5 GB | ~100MB for 2 years | ✅ |
| Gmail API quota | 1B units/day | ~2K units/day (10 users) | ✅ |
| Gemini Flash | 1,500 req/day | ~200/day steady state | ✅ |
| GitHub Actions minutes | 2,000/month | **0** (GHA cron deleted) | ✅ |
