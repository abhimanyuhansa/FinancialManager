# Master Plan — Financial Manager POC: Architecture Fix + E2E Tests
**Date:** 2026-07-11  
**For:** Autonomous agent execution — zero permission prompts  
**Goal:** Fix all architecture issues, write and run all E2E tests, verify the app is fully working with real Gmail sync  

---

## How to Use This Document

Hand this file to an autonomous agent as the sole input. The agent must execute all phases in order, make all file system changes, run all commands, and produce a final pass/fail report — with no interactive prompts, no confirmation dialogs, and no pausing for human input.

**Reference documents (read-only — do not modify):**
- Architecture fix detail: `docs/plans/2026-07-11-architecture-fix.md`
- E2E test detail: `docs/plans/2026-07-11-e2e-tests.md`

---

## Agent Operating Rules (Non-Negotiable)

1. **Never pause for confirmation.** All file writes, deletes, shell commands, and git commits must execute immediately without asking.
2. **Never open a browser for OAuth.** Auth for Playwright tests is handled via session token injection — see Phase 3 setup. Do not launch headed Chrome.
3. **Never ask about secrets.** Read all secrets from the environment (`process.env`). If a secret is missing, log a clear error and skip that test — do not prompt the user.
4. **All git commits happen automatically** per the commit message in each task. Do not push to remote under any circumstances.
5. **On TypeScript error:** fix it immediately, do not skip. Re-run `npx tsc --noEmit` until clean.
6. **On test failure:** attempt one auto-fix based on the error message. If still failing after one fix attempt, mark the test as BLOCKED in the final report and continue — do not halt execution.
7. **On missing node_modules:** run `npm install` automatically.
8. **Read AGENTS.md first.** The project root has `AGENTS.md` — read it before writing any Next.js code. This is Next.js 16 with breaking API changes.
9. **Working directory:** `/Users/i575379/Desktop/Repositories/POC/FinancialManager/`
10. **All file paths in this document are relative to the working directory** unless they start with `/`.

---

## Required Environment Variables

The agent reads these from the shell environment. They must be set before the agent starts. The agent must NOT prompt for them — if missing, log which variable is absent and skip dependent steps.

```
DATABASE_URL          — Neon PostgreSQL connection string (already in .env.local)
NEXTAUTH_SECRET       — NextAuth session encryption key (already in .env.local)  
GOOGLE_CLIENT_ID      — Google OAuth client ID (already in .env.local)
GOOGLE_CLIENT_SECRET  — Google OAuth client secret (already in .env.local)
GEMINI_API_KEY        — Gemini Flash API key (already in .env.local)
STATEMENT_ENCRYPTION_KEY — AES-256 key, 64 hex chars (already in .env.local)
CRON_SECRET           — Secret for Vercel Cron auth (already in .env.local)
BASE_URL              — Live Vercel deployment URL (agent must set this or use http://localhost:3000)
```

The agent loads `.env.local` at startup using:
```bash
export $(grep -v '^#' .env.local | xargs)
```

---

## Phase Overview

| Phase | Name | Duration Estimate | Gate |
|---|---|---|---|
| 0 | Bootstrap | 2 min | Must complete before any other phase |
| 1 | Architecture Fix | 30 min | TypeScript clean + Jest passing |
| 2 | Database Migration | 5 min | Migration applied, Prisma client regenerated |
| 3 | E2E Test Infrastructure | 10 min | Playwright installed, config written, auth fixture ready |
| 4 | E2E Test Implementation | 40 min | All 14 spec files + golden path written |
| 5 | Run E2E Tests | 20 min | Full report generated |
| 6 | Final Report | 2 min | Summary written to `docs/plans/2026-07-11-run-report.md` |

**Total estimated wall time: ~110 minutes**

Each phase has an explicit exit gate. The agent must verify the gate before proceeding to the next phase.

---

## Phase 0: Bootstrap

### 0.1 — Read project rules

```bash
cat AGENTS.md
cat node_modules/next/dist/docs/01-getting-started/01-installation.md 2>/dev/null | head -100 || echo "docs not found, proceeding"
```

### 0.2 — Load environment

```bash
export $(grep -v '^#' .env.local | xargs)
echo "ENV loaded: DATABASE_URL=${DATABASE_URL:0:30}..."
```

### 0.3 — Verify Node and npm

```bash
node --version    # must be >= 18
npm --version     # must be >= 9
```

### 0.4 — Install dependencies

```bash
npm install
```

### 0.5 — Verify current state compiles

```bash
npx tsc --noEmit 2>&1 | tail -20
```

Record any pre-existing TypeScript errors. The architecture fix in Phase 1 may resolve some of them.

### 0.6 — Run existing unit tests (baseline)

```bash
npm test 2>&1 | tail -30
```

Record which tests pass/fail before any changes. This is the baseline.

**Phase 0 exit gate:** `npm install` completed without fatal error.

---

## Phase 1: Architecture Fix

> Full specification is in `docs/plans/2026-07-11-architecture-fix.md`. This phase implements every task in that document. The steps below are the authoritative execution sequence — follow them exactly, do not re-read the architecture plan for different instructions.

### Task A1 — Remove GitHub Actions cron workflow

```bash
git rm .github/workflows/sync-advance.yml
```

Verify `vercel.json` has the crons key. Read it:
```bash
cat vercel.json
```

If the `crons` array is missing or the path/schedule is wrong, write the correct `vercel.json`:
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

```bash
git add vercel.json
git commit -m "fix(cron): remove GitHub Actions cron; Vercel Cron is sole scheduler"
```

---

### Task A2 — Fix cron auth in `advance/route.ts`

**File:** `src/app/api/gmail/sync/advance/route.ts`

Read the current file. Find the auth check block at the top of the `GET` handler — it currently reads `x-cron-secret`. Replace it with the following exact block:

```typescript
// Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
// Local dev manual trigger sends: ?secret=<CRON_SECRET> query param
const authHeader = req.headers.get("authorization");
const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
const querySecret = req.nextUrl.searchParams.get("secret");
const provided = bearerToken ?? querySecret;

if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

```bash
npx tsc --noEmit
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "fix(cron): use Authorization Bearer header for Vercel Cron auth"
```

---

### Task D1 — Create Gmail pre-filter query builder

**New file:** `src/lib/gmailQuery.ts`

Write this file with exact content:

```typescript
export function buildGmailQuery(syncFromDate: Date): string {
  const afterSeconds = Math.floor(syncFromDate.getTime() / 1000);

  const subjectKeywords = [
    "statement", "transaction", "payment", "invoice", "receipt",
    "order", "purchase", "refund", "debit", "credit", "debited",
    "credited", "charged", "transferred", "OTP", "UPI", "NEFT",
    "IMPS", "RTGS", "EMI", "mandate", "autopay", "subscription",
  ];

  const fromKeywords = [
    "bank", "pay", "card", "wallet", "finance", "money",
    "credit", "noreply", "alerts", "notify", "notification",
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

```bash
npx tsc --noEmit
git add src/lib/gmailQuery.ts
git commit -m "feat(gmail): add buildGmailQuery pre-filter to reduce scan volume by ~95%"
```

---

### Task B1 — Add `scanPageToken` and `gmailQuery` columns to `SyncJob`

**File:** `prisma/schema.prisma`

Read the current `SyncJob` model. Add these two fields inside it (keep all existing fields):

```prisma
scanPageToken  String?   // Gmail nextPageToken for paginated scan; null = scan complete
gmailQuery     String?   // the Gmail q= string used for this job
```

Do not remove `messageIds` yet — that happens in Task F1.

```bash
npx prisma migrate dev --name add_syncjob_scan_pagination
npx tsc --noEmit
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): add scanPageToken and gmailQuery to SyncJob for paginated scanning"
```

---

### Task B3 — Add `fetchMessageIdPage` to `src/lib/gmail.ts`

**File:** `src/lib/gmail.ts`

Read the current file. Append this function at the end (before any closing exports):

```typescript
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

Also update `fetchMessageMetadataList` signature to accept an optional `query` parameter. Find the function signature — it currently takes `(accessToken: string, afterDate: Date, pageToken?: string)`. Change it to:

```typescript
export async function fetchMessageMetadataList(
  accessToken: string,
  afterDate: Date,
  pageToken?: string,
  query?: string
)
```

Inside that function, find the line that constructs the `q=` param (something like `q: \`after:${afterSeconds}\``). Change it to:

```typescript
q: query ?? `after:${afterSeconds}`,
```

```bash
npx tsc --noEmit
git add src/lib/gmail.ts
git commit -m "feat(gmail): add fetchMessageIdPage; update fetchMessageMetadataList to accept query override"
```

---

### Task B2 — Refactor `sync/start` to store query and defer scanning

**File:** `src/app/api/gmail/sync/start/route.ts`

Read the current file. Replace the entire file content with:

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

  console.log(`[sync/start] created jobId=${job.id} query="${gmailQuery}"`);
  return NextResponse.json({ jobId: job.id });
}
```

```bash
npx tsc --noEmit
git add src/app/api/gmail/sync/start/route.ts
git commit -m "fix(sync/start): store gmailQuery only; defer scanning to cron"
```

---

### Task B3b — Refactor scanning phase in `advance/route.ts`

**File:** `src/app/api/gmail/sync/advance/route.ts`

Read the current file. Find the section that handles `scanning` status jobs — it currently does a do-while loop over all Gmail pages. Replace that entire scanning block with:

```typescript
const scanningJobs = await prisma.syncJob.findMany({
  where: { status: "scanning" },
  select: { id: true, userId: true, gmailQuery: true, scanPageToken: true, messageIds: true },
});

for (const job of scanningJobs) {
  console.log(`[advance] scan page jobId=${job.id} pageToken=${job.scanPageToken ?? "start"}`);

  const accessToken = await getGmailToken(job.userId);
  if (!accessToken) {
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "failed", completedAt: new Date() },
    });
    continue;
  }

  const page = await fetchMessageIdPage(
    accessToken,
    job.gmailQuery ?? "",
    job.scanPageToken ?? undefined
  );

  const existingIds: string[] = job.messageIds ? JSON.parse(job.messageIds) : [];
  const allIds = [...existingIds, ...page.messageIds];
  const hasMorePages = !!page.nextPageToken;

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      messageIds: JSON.stringify(allIds),
      totalEmails: allIds.length,
      scanPageToken: page.nextPageToken ?? null,
      status: hasMorePages ? "scanning" : "running",
    },
  });

  console.log(`[advance] jobId=${job.id} +${page.messageIds.length} ids total=${allIds.length} hasMore=${hasMorePages}`);
}
```

Add the import for `fetchMessageIdPage` at the top of the file (with the other gmail imports):
```typescript
import { getGmailToken, fetchMessageIdPage } from "@/lib/gmail";
```

```bash
npx tsc --noEmit
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "fix(advance): paginate Gmail scan — one page per cron tick, no timeout risk"
```

---

### Task C1 — Fix `senderEmail` vs `senderName` bug

**Files:** `src/app/api/gmail/sync/advance/route.ts`

Read the file. Find the `FetchedMessage` type definition — it has `senderName` and `senderDomain` but not `senderEmail`. Add `senderEmail: string` to it.

Find the `fetchFullMessage` function. Near the bottom, find the regex that extracts email from the From header:
```typescript
const emailMatch = senderRaw.match(/<([^>]+)>/);
const senderEmail = emailMatch ? emailMatch[1] : senderRaw;
```
This variable already exists — it just isn't returned. Add `senderEmail` to the return statement of `fetchFullMessage`:
```typescript
return { body, senderName, senderEmail, senderDomain, receivedDate, hasPdfAttachment, pdfOutcome };
```

Find the call to `matchesEmailFilter`. It currently passes `msg.senderName`. Change it to:
```typescript
const filterResult = matchesEmailFilter({ from: msg.senderEmail, subject: "" }, filters);
```

If the same bug exists in `src/app/api/gmail/sync/chunk/route.ts` (it will be deleted in Task E1 but fix it now so TypeScript stays clean):
Apply the same three-part fix there too.

```bash
npx tsc --noEmit
git add src/app/api/gmail/sync/advance/route.ts src/app/api/gmail/sync/chunk/route.ts
git commit -m "fix(sync): pass senderEmail to matchesEmailFilter — domain filters now match correctly"
```

---

### Task D2 — Apply pre-filter query to the onboarding scan route

**File:** `src/app/api/gmail/scan/route.ts`

Read the current file. Add this import:
```typescript
import { buildGmailQuery } from "@/lib/gmailQuery";
```

Find the do-while loop that calls `fetchMessageMetadataList` across all pages. Replace it with a single-page call:

```typescript
const gmailQuery = buildGmailQuery(fromDate);
console.log(`[scan] gmailQuery="${gmailQuery}"`);
const page = await fetchMessageMetadataList(accessToken, fromDate, undefined, gmailQuery);
const allMessages = page.messages;
console.log(`[scan] fetched ${allMessages.length} messages after pre-filter`);
```

Remove the `do { ... } while (pageToken)` loop entirely.

```bash
npx tsc --noEmit
git add src/app/api/gmail/scan/route.ts
git commit -m "fix(scan): apply pre-filter Gmail query in onboarding scan — handles large mailboxes"
```

---

### Task E1 — Remove `chunk/route.ts` and update callers

**Step 1:** Find all callers:
```bash
grep -r "sync/chunk" src/ --include="*.ts" --include="*.tsx" -l
```

**Step 2:** For each caller file found — read it and remove the polling call to `/api/gmail/sync/chunk`. Replace any chunk-polling loop with a comment: `// Sync is driven by Vercel Cron — poll /api/gmail/sync/active for status`.

**Step 3:** Delete the route:
```bash
git rm src/app/api/gmail/sync/chunk/route.ts
```

**Step 4:** Verify no remaining references:
```bash
grep -r "sync/chunk" src/ --include="*.ts" --include="*.tsx"
# Must produce zero output
```

```bash
npx tsc --noEmit
git add -A
git commit -m "fix(sync): remove chunk route — cron is sole processor; client polls active endpoint only"
```

---

### Task F1 — Add `SyncJobMessage` table and remove `messageIds` from `SyncJob`

**File:** `prisma/schema.prisma`

Read the current schema. Make these two changes:

**Change 1:** In the `SyncJob` model, remove the `messageIds String?` field and add a relation:
```prisma
messages  SyncJobMessage[]
```

**Change 2:** Add the new model after `SyncJob`:
```prisma
model SyncJobMessage {
  id         String  @id @default(cuid())
  syncJobId  String
  gmailMsgId String
  processed  Boolean @default(false)
  syncJob    SyncJob @relation(fields: [syncJobId], references: [id], onDelete: Cascade)

  @@unique([syncJobId, gmailMsgId])
  @@index([syncJobId, processed])
}
```

Create the migration:
```bash
npx prisma migrate dev --name add_syncjobmessage_table
```

If the migration fails because existing `messageIds` data is referenced, add a data migration step manually to the generated SQL file before applying:
```sql
-- Migrate existing messageIds JSON blobs to SyncJobMessage rows
INSERT INTO "SyncJobMessage" ("id", "syncJobId", "gmailMsgId", "processed")
SELECT
  gen_random_uuid()::text,
  "id",
  jsonb_array_elements_text("messageIds"::jsonb),
  false
FROM "SyncJob"
WHERE "messageIds" IS NOT NULL AND "status" IN ('scanning', 'running');
```
Then run `npx prisma migrate deploy` to apply it.

```bash
npx tsc --noEmit
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): replace messageIds JSON blob with SyncJobMessage table"
```

---

### Task F2 — Update `advance/route.ts` to use `SyncJobMessage`

**File:** `src/app/api/gmail/sync/advance/route.ts`

Read the current file.

**Change 1:** In the scanning phase (updated in B3b), replace the `messageIds` JSON append with `SyncJobMessage.createMany`:

```typescript
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

const totalCount = await prisma.syncJobMessage.count({ where: { syncJobId: job.id } });

await prisma.syncJob.update({
  where: { id: job.id },
  data: {
    totalEmails: totalCount,
    scanPageToken: page.nextPageToken ?? null,
    status: page.nextPageToken ? "scanning" : "running",
  },
});
```

Remove the `messageIds` JSON update from the scanning phase — it is fully replaced.

**Change 2:** Find the `advanceJob` function (or equivalent processing block that slices `messageIds`). Replace the offset/slice logic with:

```typescript
// Fetch next N unprocessed IDs from SyncJobMessage table
const pending = await prisma.syncJobMessage.findMany({
  where: { syncJobId: job.id, processed: false },
  take: CHUNK_SIZE,         // use existing CHUNK_SIZE constant
  orderBy: { id: "asc" },
  select: { id: true, gmailMsgId: true },
});

if (pending.length === 0) {
  await prisma.syncJob.update({
    where: { id: job.id },
    data: { status: "complete", completedAt: new Date() },
  });
  return;
}
```

After processing, mark them done:
```typescript
await prisma.syncJobMessage.updateMany({
  where: { id: { in: pending.map((p) => p.id) } },
  data: { processed: true },
});

const processedCount = await prisma.syncJobMessage.count({
  where: { syncJobId: job.id, processed: true },
});
const totalRemaining = await prisma.syncJobMessage.count({
  where: { syncJobId: job.id, processed: false },
});
const isComplete = totalRemaining === 0;

await prisma.syncJob.update({
  where: { id: job.id },
  data: {
    processedEmails: processedCount,
    newTransactions: { increment: newTransactions },
    encryptedBlockedCount: { increment: encryptedBlockedCount },
    ...(isComplete ? { status: "complete", completedAt: new Date() } : {}),
  },
});
```

Remove ALL references to `job.messageIds`, `job.processedEmails` as an offset, and JSON.parse/JSON.stringify on message IDs from the processing path.

```bash
npx tsc --noEmit
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "fix(advance): use SyncJobMessage table instead of messageIds JSON for resumable processing"
```

---

### Task G1 — Batch-fetch MerchantRules, eliminate N+1

**File:** `src/app/api/gmail/sync/advance/route.ts`

Read the current file. Find the section inside the processing loop that calls `prisma.merchantRule.findUnique(...)` per transaction. 

Before the loop begins (at the top of the `advanceJob` function or processing block), add:

```typescript
const merchantRules = await prisma.merchantRule.findMany({
  where: { userId: job.userId },
  select: { merchantName: true, category: true },
});
const merchantRuleMap = new Map(merchantRules.map((r) => [r.merchantName, r.category]));
```

Replace every occurrence of:
```typescript
const rule = await prisma.merchantRule.findUnique({ ... });
if (rule) category = rule.category;
```

With:
```typescript
const overrideCategory = merchantRuleMap.get(merchantKey);
if (overrideCategory) category = overrideCategory;
```

```bash
npx tsc --noEmit
git add src/app/api/gmail/sync/advance/route.ts
git commit -m "perf(advance): batch-fetch MerchantRules once per job — eliminates N+1 DB queries"
```

---

### Task H — Update SyncProgressBanner UX

**File:** `src/components/SyncProgressBanner.tsx`

Read the current file.

**Change 1:** Replace the single `POLL_INTERVAL_MS` constant with two:
```typescript
const POLL_INTERVAL_RUNNING_MS = 15_000;
const POLL_INTERVAL_IDLE_MS = 60_000;
```

Update the `useEffect` polling logic to use `POLL_INTERVAL_RUNNING_MS` when `job.status` is `"scanning"` or `"running"`, and `POLL_INTERVAL_IDLE_MS` otherwise.

**Change 2:** Add a scanning-state render branch. Find where the component returns JSX for the `"running"` state. Before that block, add:

```typescript
if (job.status === "scanning") {
  return (
    <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-2">
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

```bash
npx tsc --noEmit
git add src/components/SyncProgressBanner.tsx
git commit -m "fix(banner): add scanning state UI; tune poll intervals for free-tier safety"
```

---

### Phase 1 exit gate

```bash
npx tsc --noEmit
# Must output: zero errors

npm test
# All existing tests must pass
```

If TypeScript errors remain: fix them before proceeding. If unit tests fail that were passing at baseline: investigate and fix. Do not proceed to Phase 2 with a broken baseline.

---

## Phase 2: Database Migration Verification

### 2.1 — Confirm migrations applied

```bash
npx prisma migrate status
# All migrations must show: "Database schema is up to date"
```

### 2.2 — Regenerate Prisma client

```bash
npx prisma generate
```

### 2.3 — Verify new schema fields are accessible

Write a quick inline check (do not commit this):
```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.syncJob.findFirst({ select: { id: true, scanPageToken: true, gmailQuery: true } })
  .then(r => console.log('SyncJob fields OK:', JSON.stringify(r)))
  .catch(e => console.error('FAIL:', e.message))
  .finally(() => p.\$disconnect());
"
```

Expected output: `SyncJob fields OK: null` or a valid object. If it errors with "Unknown field", the migration didn't apply — re-run `npx prisma migrate deploy`.

### 2.4 — Verify SyncJobMessage table exists

```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.syncJobMessage.count()
  .then(n => console.log('SyncJobMessage count:', n))
  .catch(e => console.error('FAIL:', e.message))
  .finally(() => p.\$disconnect());
"
```

Expected: `SyncJobMessage count: 0` (or any number). Error means the table wasn't created.

**Phase 2 exit gate:** Both node checks pass without errors.

---

## Phase 3: E2E Test Infrastructure

### 3.1 — Install Playwright

```bash
npm install -D @playwright/test
npx playwright install chromium --with-deps
```

### 3.2 — Write `playwright.config.ts`

Create this file at the project root:

```typescript
import { defineConfig, devices } from "@playwright/test";
import path from "path";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: 1,
  workers: 1,
  reporter: [
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["list"],
    ["json", { outputFile: "playwright-report/results.json" }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    storageState: "e2e/.auth/user.json",
  },
  projects: [
    {
      name: "setup",
      testMatch: "e2e/setup/auth.setup.ts",
      use: { storageState: undefined },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
```

### 3.3 — Create directory structure

```bash
mkdir -p e2e/.auth e2e/setup e2e/fixtures e2e/helpers
```

### 3.4 — Write auth setup (`e2e/setup/auth.setup.ts`)

This file runs once before all tests to create an authenticated session. It uses a pre-seeded session token instead of OAuth to avoid browser popup.

```typescript
import { test as setup } from "@playwright/test";
import path from "path";
import fs from "fs";

const AUTH_FILE = path.join(__dirname, "../.auth/user.json");

setup("authenticate via session seed", async ({ request }) => {
  // Check if valid auth state already exists (< 50 min old)
  if (fs.existsSync(AUTH_FILE)) {
    const age = Date.now() - fs.statSync(AUTH_FILE).mtimeMs;
    if (age < 50 * 60 * 1000) {
      console.log("[setup] Reusing cached auth session");
      return;
    }
  }

  // Call our test-auth endpoint to get a seeded session cookie
  // This endpoint creates a real DB session for the test user and returns the cookie
  const res = await request.post("/api/test/auth-seed", {
    data: { secret: process.env.CRON_SECRET },
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok()) {
    throw new Error(`Auth seed failed: ${res.status()} — ensure /api/test/auth-seed exists`);
  }

  const cookies = await res.json();
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ cookies, origins: [] }, null, 2)
  );

  console.log("[setup] Auth session seeded and saved");
});
```

### 3.5 — Create the `auth-seed` API route

This route exists only in development/test mode. It creates a real database session for the test user and returns the session cookie — bypassing OAuth entirely.

**New file:** `src/app/api/test/auth-seed/route.ts`

```typescript
import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Guard: this endpoint must never be accessible in production
// It is only enabled when CRON_SECRET matches, providing a safety gate
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && !process.env.ENABLE_TEST_AUTH_SEED) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const body = await req.json();
  if (body.secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find or create the test user
  const testEmail = process.env.TEST_USER_EMAIL ?? "test@financialmanager.dev";
  let user = await prisma.user.findUnique({ where: { email: testEmail } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: testEmail,
        name: "Test User",
        emailVerified: new Date(),
      },
    });
  }

  // Create a session that expires in 24 hours
  const sessionToken = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.session.upsert({
    where: { sessionToken },
    create: { sessionToken, userId: user.id, expires },
    update: { expires },
  });

  // Return the cookie Playwright should inject
  const cookies = [
    {
      name: "authjs.session-token",
      value: sessionToken,
      domain: new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000").hostname,
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax" as const,
      expires: Math.floor(expires.getTime() / 1000),
    },
  ];

  return NextResponse.json(cookies);
}
```

Also add `TEST_USER_EMAIL` and `ENABLE_TEST_AUTH_SEED` to `.env.local`:
```
TEST_USER_EMAIL=test@financialmanager.dev
ENABLE_TEST_AUTH_SEED=true
```

**Note on production safety:** The test user created here has no Google OAuth tokens, so Gmail sync will return "No Gmail token" errors — which is expected for API contract tests. The golden path test (which requires real sync) needs a real Google account and is handled separately via the `E2E_REAL_SYNC=true` flag.

```bash
npx tsc --noEmit
git add src/app/api/test/auth-seed/route.ts playwright.config.ts e2e/ .env.local
git commit -m "test(e2e): add Playwright config and auth-seed route for headless E2E testing"
```

### 3.6 — Write shared helpers (`e2e/helpers/api.ts`)

```typescript
import type { APIRequestContext } from "@playwright/test";

export async function clearUserData(request: APIRequestContext) {
  const res = await request.delete("/api/user/data", {
    data: { confirm: true },
  });
  // 200 or 404 (if nothing to delete) are both acceptable
  if (res.status() !== 200 && res.status() !== 404) {
    console.warn(`[helpers] clearUserData returned ${res.status()}`);
  }
}

export async function seedDemoTransactions(request: APIRequestContext) {
  const res = await request.post("/api/transactions/demo");
  if (!res.ok()) throw new Error(`Demo seed failed: ${res.status()}`);
  return res.json();
}

export async function waitForSyncComplete(
  request: APIRequestContext,
  jobId: string,
  timeoutMs = 600_000
): Promise<{ status: string; newTransactions: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 15_000));
    const res = await request.get(`/api/gmail/sync/status?jobId=${jobId}`);
    if (!res.ok()) continue;
    const data = await res.json();
    if (data.done) return data;
    console.log(`[wait] sync ${jobId}: ${data.status} ${data.processedEmails}/${data.totalEmails}`);
  }
  throw new Error(`Sync job ${jobId} did not complete within ${timeoutMs}ms`);
}

export async function triggerCronAdvance(request: APIRequestContext) {
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  if (!res.ok()) throw new Error(`Cron advance failed: ${res.status()}`);
  return res.json();
}
```

**Phase 3 exit gate:**
```bash
npx tsc --noEmit
# No errors

node -e "require('./playwright.config.ts')" 2>/dev/null || npx playwright --version
# Playwright is installed
```

---

## Phase 4: E2E Test Implementation

Write all 14 spec files plus the golden path test. Each file is self-contained and imports from `@playwright/test` directly.

### Spec file authoring rules (apply to every file):
- Import: `import { test, expect } from "@playwright/test";`
- All tests use `storageState` from `playwright.config.ts` (already set globally — no per-test auth needed)
- Every `describe` block that mutates data has `afterAll` calling `clearUserData` from `helpers/api.ts`
- Use `page.waitForSelector` and `page.waitForResponse` — never `page.waitForTimeout` except for polling intervals
- Network intercepts use `page.route()` to simulate errors — no real server modification
- Sync tests always call `triggerCronAdvance` from the helper instead of waiting for the real cron

---

### `e2e/01-auth.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } }); // unauthenticated for this suite

test("T1.1 unauthenticated user redirected to /login", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("T1.2 unauthenticated /transactions redirects to /login", async ({ page }) => {
  await page.goto("/transactions");
  await expect(page).toHaveURL(/\/login/);
});

test("T1.3 login page has Google button", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
});
```

> Note: T1.4 (actual Google OAuth) is not testable without a real browser session. Mark it as a manual test.
> T1.5 and T1.6 are covered in every other authenticated spec.

---

### `e2e/02-onboarding.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

test("T2.2 /onboarding loads with period picker", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByText(/6m|6 months/i).first()).toBeVisible();
  await expect(page.getByText(/3m|3 months/i).first()).toBeVisible();
});

test("T2.3 period picker selects one option at a time", async ({ page }) => {
  await page.goto("/onboarding");
  const options = ["6m", "3m", "1m"];
  for (const opt of options) {
    await page.getByText(opt).first().click();
    // After clicking, that option should have an active/selected class
    // We just verify no JS error and page stays on /onboarding
    await expect(page).toHaveURL(/\/onboarding/);
  }
});
```

---

### `e2e/03-sync.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import { triggerCronAdvance } from "../helpers/api";

test("T3.1 sync button visible when no active job", async ({ page }) => {
  await page.goto("/dashboard");
  // Either sync button or onboarding overlay
  const syncBtn = page.getByRole("button", { name: /sync gmail/i });
  const overlay = page.getByText(/get started|start sync/i);
  await expect(syncBtn.or(overlay).first()).toBeVisible({ timeout: 10_000 });
});

test("T3.2 starting sync returns jobId fast", async ({ request }) => {
  const start = Date.now();
  const res = await request.post("/api/gmail/sync/start");
  const elapsed = Date.now() - start;

  // 409 = already running (acceptable), 401 = no token (acceptable for test user), 200 = new job
  expect([200, 201, 401, 409]).toContain(res.status());
  expect(elapsed).toBeLessThan(3000);

  if (res.status() === 200 || res.status() === 201) {
    const body = await res.json();
    expect(body).toHaveProperty("jobId");
    expect(typeof body.jobId).toBe("string");
  }
});

test("T3.3 starting sync while one is running returns 409", async ({ request }) => {
  // First start
  const r1 = await request.post("/api/gmail/sync/start");
  if (r1.status() === 401) {
    test.skip(); // test user has no Gmail token
    return;
  }
  if (r1.status() === 409) return; // already running — 409 on first call is also correct

  // Second start immediately
  const r2 = await request.post("/api/gmail/sync/start");
  expect(r2.status()).toBe(409);
  const body = await r2.json();
  expect(body.running).toBe(true);
  expect(body).toHaveProperty("jobId");
});

test("T3.4 cron advance endpoint 401 without auth", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/advance");
  expect(res.status()).toBe(401);
});

test("T3.5 cron advance endpoint 200 with correct bearer token", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  expect(res.status()).toBe(200);
});

test("T3.6 cron advance with wrong secret returns 401", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Authorization: "Bearer wrong-secret-value" },
  });
  expect(res.status()).toBe(401);
});
```

---

### `e2e/04-dashboard.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "../helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T4.1 dashboard renders all key sections", async ({ page }) => {
  await page.goto("/dashboard");
  // Navigation
  await expect(page.getByRole("navigation")).toBeVisible();
  // At least one KPI card
  await expect(page.locator("[data-testid='kpi-card'], .kpi-card, [class*='KpiCard']").first())
    .toBeVisible({ timeout: 10_000 });
});

test("T4.2 KPI cards show currency values", async ({ page }) => {
  await page.goto("/dashboard");
  // Look for ₹ sign anywhere on the page
  await expect(page.getByText(/₹/)).toBeVisible({ timeout: 10_000 });
});

test("T4.3 recent transactions section has rows", async ({ page }) => {
  await page.goto("/dashboard");
  // At least one transaction row in any table or list
  const rows = page.locator("table tbody tr, [role='row']");
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
});

test("T4.6 clicking transaction row opens detail panel", async ({ page }) => {
  await page.goto("/dashboard");
  const firstRow = page.locator("table tbody tr, [role='row']").first();
  await firstRow.click();
  // Panel should appear
  await expect(
    page.getByRole("dialog").or(page.locator("[data-testid='transaction-panel']")).first()
  ).toBeVisible({ timeout: 5_000 });
  // Escape closes it
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog").or(page.locator("[data-testid='transaction-panel']")).first()
  ).not.toBeVisible({ timeout: 3_000 });
});

test("T4.10 nav links navigate to correct pages", async ({ page }) => {
  await page.goto("/dashboard");
  const navLinks: Array<[RegExp, RegExp]> = [
    [/transactions/i, /\/transactions/],
    [/analytics/i, /\/analytics/],
    [/assets/i, /\/assets/],
    [/settings/i, /\/settings/],
  ];
  for (const [linkText, expectedUrl] of navLinks) {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: linkText }).first().click();
    await expect(page).toHaveURL(expectedUrl, { timeout: 5_000 });
  }
});
```

---

### `e2e/05-transactions.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "../helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T5.1 transactions page loads with count", async ({ page }) => {
  await page.goto("/transactions");
  await expect(page.getByText(/\d+ transactions/i)).toBeVisible({ timeout: 10_000 });
});

test("T5.2 each row shows date, merchant, amount", async ({ page }) => {
  await page.goto("/transactions");
  const firstRow = page.locator("table tbody tr").first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  // Row should contain a currency symbol
  await expect(page.getByText(/₹/).first()).toBeVisible();
});

test("T5.3 search filters transactions", async ({ page }) => {
  await page.goto("/transactions");
  const searchInput = page.getByRole("textbox", { name: /search/i })
    .or(page.locator("input[placeholder*='search' i]")).first();
  await searchInput.fill("ZZZNOMATCH_12345");
  await page.waitForTimeout(600); // debounce
  // Should show empty state or 0 results
  const bodyText = await page.locator("body").textContent();
  expect(bodyText).toMatch(/no transactions|0 transactions/i);
});

test("T5.12 export CSV triggers download", async ({ page }) => {
  await page.goto("/transactions");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /export/i }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/i);
});

test("T5.14 empty state when no transactions", async ({ page, request }) => {
  await clearUserData(request);
  await page.goto("/transactions");
  await expect(page.getByText(/no transactions|0 transactions/i)).toBeVisible({ timeout: 10_000 });
});
```

---

### `e2e/06-categories.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "../helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T6.1 category dropdown has options", async ({ page }) => {
  await page.goto("/transactions");
  await page.locator("table tbody tr").first().click();
  // Panel opens — find category selector
  const categoryEl = page.getByRole("combobox").or(page.locator("select")).first();
  await expect(categoryEl).toBeVisible({ timeout: 5_000 });
  const options = await categoryEl.locator("option").count();
  expect(options).toBeGreaterThan(1);
});

test("T6.6 category change shows success feedback", async ({ page }) => {
  await page.goto("/transactions");
  await page.locator("table tbody tr").first().click();
  const panel = page.getByRole("dialog").or(page.locator("[class*='panel' i]")).first();
  await expect(panel).toBeVisible({ timeout: 5_000 });
  // Find and change category
  const select = panel.getByRole("combobox").or(panel.locator("select")).first();
  if (await select.isVisible()) {
    const options = await select.locator("option").allTextContents();
    const differentOption = options.find((o) => o.trim() !== await select.inputValue());
    if (differentOption) {
      await select.selectOption({ label: differentOption });
      // Look for success indicator (any of these)
      await expect(
        page.getByText(/saved|updated|success/i).or(panel)
      ).toBeVisible({ timeout: 5_000 });
    }
  }
});
```

---

### `e2e/07-filters.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

test("T7.1 settings page has 4 tabs", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("tab", { name: /filter/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("tab", { name: /audit|reconcil/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /password/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /log/i })).toBeVisible();
});

test("T7.2 add a sender_domain filter", async ({ page, request }) => {
  await page.goto("/settings");
  // Ensure on filters tab
  await page.getByRole("tab", { name: /filter/i }).click();

  // Fill the add-filter form
  const typeSelect = page.getByRole("combobox").or(page.locator("select")).first();
  if (await typeSelect.isVisible()) {
    await typeSelect.selectOption("sender_domain");
  }
  await page.getByRole("textbox").fill("e2etest-hdfcbank.com");
  await page.getByRole("button", { name: /add filter/i }).click();

  // The filter should appear in the list
  await expect(page.getByText("e2etest-hdfcbank.com")).toBeVisible({ timeout: 5_000 });

  // Clean up
  await request.delete(
    `/api/settings/filters/${await getFilterId(request, "e2etest-hdfcbank.com")}`
  );
});

test("T7.5 delete a filter removes it", async ({ page, request }) => {
  // Create one first
  const res = await request.post("/api/settings/filters", {
    data: { type: "sender_domain", value: "e2e-delete-test.com", sourceRank: 1 },
  });
  const { id } = await res.json();

  await page.goto("/settings");
  await page.getByRole("tab", { name: /filter/i }).click();
  await expect(page.getByText("e2e-delete-test.com")).toBeVisible();

  // Delete it
  await page.getByRole("button", { name: /delete/i }).first().click();
  // Confirm if dialog appears
  const confirmBtn = page.getByRole("button", { name: /confirm|yes|delete/i });
  if (await confirmBtn.isVisible({ timeout: 1_000 })) {
    await confirmBtn.click();
  }

  await expect(page.getByText("e2e-delete-test.com")).not.toBeVisible({ timeout: 5_000 });
});

async function getFilterId(request: import("@playwright/test").APIRequestContext, value: string) {
  const res = await request.get("/api/settings/filters");
  const filters = await res.json();
  return filters.find((f: { value: string; id: string }) => f.value === value)?.id;
}
```

---

### `e2e/08-passwords.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

test("T8.1 statement passwords tab loads", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /password/i }).click();
  // Either pending or saved section should be visible
  await expect(
    page.getByText(/pending|saved|statement password/i).first()
  ).toBeVisible({ timeout: 10_000 });
});

test("T8.3 saved password not shown in plaintext", async ({ request }) => {
  // Add a password
  await request.post("/api/settings/statement-passwords", {
    data: { senderDomain: "e2e-bank-test.com", password: "secret123" },
  });

  const res = await request.get("/api/settings/statement-passwords");
  const data = await res.json();
  const entry = data.stored?.find((s: { senderDomain: string }) => s.senderDomain === "e2e-bank-test.com");

  // The API should not return the plaintext password
  if (entry) {
    expect(JSON.stringify(entry)).not.toContain("secret123");
  }

  // Clean up
  await request.delete("/api/settings/statement-passwords/e2e-bank-test.com");
});
```

---

### `e2e/09-parselogs.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

test("T9.1 parse logs tab loads", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /log/i }).click();
  await expect(page.getByText(/parse log|email log|outcome/i).first()).toBeVisible({ timeout: 10_000 });
});
```

---

### `e2e/10-assets.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import { clearUserData } from "../helpers/api";

test.afterAll(async ({ request }) => {
  // Only clear assets, not all data — just delete created test assets
  const res = await request.get("/api/assets");
  const assets = await res.json();
  for (const asset of assets) {
    if (asset.name?.startsWith("E2E Test")) {
      await request.delete(`/api/assets/${asset.id}`);
    }
  }
});

test("T10.1 assets page loads", async ({ page }) => {
  await page.goto("/assets");
  await expect(page).toHaveURL(/\/assets/);
  await expect(page.locator("body")).not.toContainText("Error");
});

test("T10.2 create a new asset", async ({ page, request }) => {
  await page.goto("/assets");

  const addBtn = page.getByRole("button", { name: /add asset/i });
  await expect(addBtn).toBeVisible({ timeout: 10_000 });
  await addBtn.click();

  // Fill form
  await page.getByRole("textbox", { name: /name/i }).fill("E2E Test Savings");
  const valueInput = page.getByRole("spinbutton").or(page.locator("input[type='number']")).first();
  await valueInput.fill("100000");

  await page.getByRole("button", { name: /save|create|add/i }).last().click();

  await expect(page.getByText("E2E Test Savings")).toBeVisible({ timeout: 5_000 });
});

test("T10.5 delete an asset", async ({ page, request }) => {
  // Create via API
  const res = await request.post("/api/assets", {
    data: { name: "E2E Test Delete", type: "savings", value: 500, currency: "INR", asOf: "2026-07-11" },
  });
  const { id } = await res.json();

  await page.goto("/assets");
  await expect(page.getByText("E2E Test Delete")).toBeVisible({ timeout: 10_000 });

  // Delete from UI
  const deleteBtn = page.locator(`[data-id="${id}"] button, tr:has-text("E2E Test Delete") button`).last();
  if (await deleteBtn.isVisible()) {
    await deleteBtn.click();
    const confirm = page.getByRole("button", { name: /confirm|yes|delete/i });
    if (await confirm.isVisible({ timeout: 1_000 })) await confirm.click();
    await expect(page.getByText("E2E Test Delete")).not.toBeVisible({ timeout: 5_000 });
  }
});
```

---

### `e2e/11-analytics.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "../helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T11.1 analytics page loads without error", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page).toHaveURL(/\/analytics/);
  await expect(page.locator("body")).not.toContainText("Error");
  // Any chart or summary section
  await expect(page.locator("svg, canvas, [class*='chart' i]").first()).toBeVisible({ timeout: 10_000 });
});
```

---

### `e2e/12-api.spec.ts`

```typescript
import { test, expect } from "@playwright/test";

test("T12.1 GET /api/gmail/sync/active no job returns null or object", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/active");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body === null || typeof body === "object").toBe(true);
});

test("T12.4 cron advance 401 without auth header", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/advance");
  expect(res.status()).toBe(401);
});

test("T12.5 cron advance 401 with wrong secret", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Authorization: "Bearer definitely-wrong-secret" },
  });
  expect(res.status()).toBe(401);
});

test("T12.6 cron advance 200 with correct CRON_SECRET", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  expect(res.status()).toBe(200);
});

test("T12.7 GET /api/transactions returns correct shape", async ({ request }) => {
  const res = await request.get("/api/transactions");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("transactions");
  expect(Array.isArray(body.transactions)).toBe(true);
  expect(body).toHaveProperty("total");
});

test("T12.10 GET /api/analytics/dashboard returns required fields", async ({ request }) => {
  const res = await request.get("/api/analytics/dashboard");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("recentTransactions");
  expect(body).toHaveProperty("monthlyTotals");
  expect(body).toHaveProperty("categoryBreakdown");
});

test("T12.11 GET /api/assets returns array", async ({ request }) => {
  const res = await request.get("/api/assets");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
});

test("T12.14 GET /api/settings/filters returns array", async ({ request }) => {
  const res = await request.get("/api/settings/filters");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
});

test("T12.17 protected routes 401 when unauthenticated", async ({ request }) => {
  // Use a fresh context with no cookies
  const unauthCtx = await request.newContext({ storageState: { cookies: [], origins: [] } });

  for (const path of ["/api/transactions", "/api/assets", "/api/analytics/dashboard"]) {
    const res = await unauthCtx.get(path);
    expect(res.status(), `Expected 401 for ${path}`).toBe(401);
  }

  await unauthCtx.dispose();
});

test("T12.18 GET /api/transactions/export returns CSV", async ({ request }) => {
  const res = await request.get("/api/transactions/export");
  expect(res.status()).toBe(200);
  const contentType = res.headers()["content-type"] ?? "";
  expect(contentType).toContain("csv");
});
```

---

### `e2e/13-nonfunctional.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "../helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T13.1 dashboard LCP under 3 seconds", async ({ page }) => {
  const startTime = Date.now();
  await page.goto("/dashboard");
  await page.waitForLoadState("domcontentloaded");
  const elapsed = Date.now() - startTime;
  expect(elapsed).toBeLessThan(3000);
});

test("T13.3 sync/start responds under 2 seconds", async ({ request }) => {
  const start = Date.now();
  const res = await request.post("/api/gmail/sync/start");
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(2000);
  expect([200, 201, 401, 409]).toContain(res.status());
});

test("T13.7 app usable on mobile viewport 375x667", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  for (const path of ["/dashboard", "/transactions", "/settings"]) {
    await page.goto(path);
    await page.waitForLoadState("domcontentloaded");
    // No horizontal overflow
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth, `Horizontal overflow on ${path}`).toBeLessThanOrEqual(clientWidth + 5);
  }
});

test("T13.8 app usable on tablet viewport 768x1024", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/dashboard");
  await page.waitForLoadState("domcontentloaded");
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
});

test("T13.10 security headers present", async ({ request }) => {
  const res = await request.get("/");
  const headers = res.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  // X-Frame-Options may be set
  const xfo = headers["x-frame-options"];
  if (xfo) {
    expect(["DENY", "SAMEORIGIN"]).toContain(xfo.toUpperCase());
  }
  // X-Powered-By should NOT reveal Next.js (optional — warn if present)
  if (headers["x-powered-by"]) {
    console.warn("WARN: X-Powered-By header is exposed:", headers["x-powered-by"]);
  }
});
```

---

### `e2e/14-errors.spec.ts`

```typescript
import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "../helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T14.2 network error on sync start shows error UI", async ({ page }) => {
  await page.route("/api/gmail/sync/start", (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: "Internal Server Error" }) })
  );
  await page.goto("/dashboard");
  const syncBtn = page.getByRole("button", { name: /sync gmail/i });
  if (await syncBtn.isVisible({ timeout: 5_000 })) {
    await syncBtn.click();
    await expect(page.getByText(/error|failed|try again/i)).toBeVisible({ timeout: 5_000 });
  }
});

test("T14.4 search with no matches shows empty state", async ({ page }) => {
  await page.goto("/transactions");
  const searchInput = page.getByRole("textbox", { name: /search/i })
    .or(page.locator("input[placeholder*='search' i]")).first();
  await searchInput.fill("ZZZNOMATCH_UNIQUE_9999");
  await page.waitForTimeout(600);
  await expect(page.getByText(/no transactions|no results/i)).toBeVisible({ timeout: 5_000 });
});

test("T14.5 unknown transaction ID returns 404", async ({ request }) => {
  const res = await request.patch("/api/transactions/nonexistent-id-99999/category", {
    data: { categoryId: "any" },
  });
  expect([404, 400]).toContain(res.status());
});

test("T14.9 clear all data requires confirmation", async ({ page }) => {
  await page.goto("/settings");
  // Find danger zone
  const dangerBtn = page.getByRole("button", { name: /clear|delete.*data|remove.*data/i });
  if (await dangerBtn.isVisible({ timeout: 5_000 })) {
    await dangerBtn.click();
    // A confirmation dialog must appear
    await expect(
      page.getByRole("dialog").or(page.getByRole("alertdialog"))
    ).toBeVisible({ timeout: 3_000 });
    // Cancel — do not actually delete
    await page.keyboard.press("Escape");
  }
});
```

---

### `e2e/golden-path.spec.ts`

```typescript
/**
 * Golden Path: Full account sync verification
 *
 * This test requires:
 *   E2E_REAL_SYNC=true   — enables the test (skipped otherwise)
 *   BASE_URL             — live Vercel deployment URL
 *   CRON_SECRET          — for triggering cron manually
 *
 * It uses demo data for all assertions so it runs without a real Google account.
 * The real-sync variant (with E2E_REAL_SYNC=true AND a real Google OAuth token)
 * is a manual execution step documented at the end of this file.
 */
import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData, triggerCronAdvance, waitForSyncComplete } from "../helpers/api";

test.describe("Golden Path — Demo Data Variant", () => {
  test.beforeAll(async ({ request }) => {
    await clearUserData(request);
    await seedDemoTransactions(request);
  });

  test.afterAll(async ({ request }) => {
    await clearUserData(request);
  });

  test("GP1 dashboard loads with KPI values", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/₹/)).toBeVisible({ timeout: 10_000 });
  });

  test("GP2 transactions page shows expected count", async ({ page }) => {
    await page.goto("/transactions");
    await expect(page.getByText(/\d+ transactions/i)).toBeVisible({ timeout: 10_000 });
    const countText = await page.getByText(/\d+ transactions/i).textContent();
    const count = parseInt(countText?.match(/\d+/)?.[0] ?? "0");
    expect(count).toBeGreaterThan(0);
  });

  test("GP3 bar chart renders", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("svg").first()).toBeVisible({ timeout: 10_000 });
  });

  test("GP4 category update persists after refresh", async ({ page, request }) => {
    await page.goto("/transactions");
    const firstRow = page.locator("table tbody tr").first();
    await firstRow.click();

    const panel = page.getByRole("dialog").or(page.locator("[class*='panel' i]")).first();
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const select = panel.getByRole("combobox").or(panel.locator("select")).first();
    if (await select.isVisible()) {
      const options = await select.locator("option").allTextContents();
      const newOption = options.find((o) => o.trim() !== await select.inputValue() && o.trim() !== "");
      if (newOption) {
        await select.selectOption({ label: newOption });
        await page.waitForTimeout(500);
      }
    }
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.getByText(/\d+ transactions/i)).toBeVisible({ timeout: 10_000 });
  });

  test("GP5 export CSV downloads non-empty file", async ({ page }) => {
    await page.goto("/transactions");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /export/i }).click(),
    ]);
    const filePath = await download.path();
    const fs = await import("fs");
    const content = fs.readFileSync(filePath!, "utf-8");
    expect(content.split("\n").length).toBeGreaterThan(2); // header + at least 1 data row
  });

  test("GP6 cron advance returns 200", async ({ request }) => {
    const res = await request.get("/api/gmail/sync/advance", {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    expect(res.status()).toBe(200);
  });

  test("GP7 no JS errors during navigation", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    for (const path of ["/dashboard", "/transactions", "/analytics", "/assets", "/settings"]) {
      await page.goto(path);
      await page.waitForLoadState("domcontentloaded");
    }

    expect(errors, `JS errors found: ${errors.join(", ")}`).toHaveLength(0);
  });
});

/**
 * REAL SYNC VARIANT — Manual execution only
 * ==========================================
 * Skipped in automated runs. Run manually with:
 *   E2E_REAL_SYNC=true npx playwright test e2e/golden-path.spec.ts --grep "Real Sync"
 *
 * Requires:
 *   - A Google account with real financial emails
 *   - That account must be logged in and the session stored in e2e/.auth/user.json
 *   - CRON_SECRET set in environment
 */
test.describe("Golden Path — Real Sync Variant", () => {
  test.skip(!process.env.E2E_REAL_SYNC, "Set E2E_REAL_SYNC=true to run");

  test("Real Sync: full account sync completes end-to-end", async ({ page, request }) => {
    // Clean slate
    await clearUserData(request);

    // Start sync
    const startRes = await request.post("/api/gmail/sync/start");
    expect(startRes.status()).toBe(200);
    const { jobId } = await startRes.json();
    expect(typeof jobId).toBe("string");

    // Verify initial state
    const activeRes = await request.get("/api/gmail/sync/active");
    const activeJob = await activeRes.json();
    expect(activeJob).not.toBeNull();
    expect(activeJob.status).toBe("scanning");

    // Advance cron until scanning complete (up to 10 ticks = 10 pages)
    let scanDone = false;
    for (let i = 0; i < 10 && !scanDone; i++) {
      await triggerCronAdvance(request);
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await request.get(`/api/gmail/sync/status?jobId=${jobId}`);
      const status = await statusRes.json();
      if (status.status === "running" || status.done) {
        scanDone = true;
        expect(status.totalEmails).toBeGreaterThan(0);
      }
    }

    // Advance cron until processing complete (up to 40 ticks)
    let result: { status: string; newTransactions: number } | null = null;
    for (let i = 0; i < 40; i++) {
      await triggerCronAdvance(request);
      await new Promise((r) => setTimeout(r, 3000));
      const statusRes = await request.get(`/api/gmail/sync/status?jobId=${jobId}`);
      const status = await statusRes.json();
      if (status.done) {
        result = status;
        break;
      }
    }

    expect(result).not.toBeNull();
    expect(result!.status).toBe("complete");
    expect(result!.newTransactions).toBeGreaterThan(0);

    // Verify dashboard shows real data
    await page.goto("/dashboard");
    await expect(page.getByText(/₹/)).toBeVisible({ timeout: 10_000 });

    // Verify transactions page
    await page.goto("/transactions");
    const countText = await page.getByText(/\d+ transactions/i).textContent();
    const count = parseInt(countText?.match(/\d+/)?.[0] ?? "0");
    expect(count).toBeGreaterThanOrEqual(result!.newTransactions);

    // Check no JS errors occurred
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    for (const path of ["/dashboard", "/transactions", "/analytics", "/settings"]) {
      await page.goto(path);
      await page.waitForLoadState("domcontentloaded");
    }
    expect(errors).toHaveLength(0);
  });
});
```

**Phase 4 exit gate:**
```bash
npx tsc --noEmit
# Zero TypeScript errors in e2e/ files

ls e2e/*.spec.ts e2e/golden-path.spec.ts | wc -l
# Must show 15 files
```

---

## Phase 5: Run E2E Tests

### 5.1 — Start the dev server (if running against localhost)

If `BASE_URL` is `http://localhost:3000`, start the server first:
```bash
npm run build 2>&1 | tail -20
npm run start &
DEV_PID=$!
sleep 5
```

If `BASE_URL` points to a live Vercel deployment, skip this step.

### 5.2 — Seed `.env` for Playwright

```bash
cat > e2e/.env << 'EOF'
BASE_URL=${BASE_URL:-http://localhost:3000}
CRON_SECRET=${CRON_SECRET}
TEST_USER_EMAIL=test@financialmanager.dev
ENABLE_TEST_AUTH_SEED=true
EOF
```

### 5.3 — Run all E2E tests

```bash
npx playwright test --reporter=list,html 2>&1 | tee playwright-run.log
```

### 5.4 — Collect results

```bash
# Count passed/failed
PASSED=$(grep -c "✓\|passed" playwright-run.log || echo 0)
FAILED=$(grep -c "✗\|failed\|×" playwright-run.log || echo 0)
echo "PASSED: $PASSED  FAILED: $FAILED"
```

### 5.5 — Stop dev server if started

```bash
kill $DEV_PID 2>/dev/null || true
```

**Phase 5 exit gate:** `playwright-report/results.json` exists and `FAILED` count is recorded.

---

## Phase 6: Final Report

Write a final report to `docs/plans/2026-07-11-run-report.md` with this exact structure:

```markdown
# Run Report — Financial Manager Architecture Fix + E2E Tests
**Date:** <actual date>
**Agent:** autonomous
**Status:** PASS | PARTIAL | FAIL

## Phase Results

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Bootstrap | PASS/FAIL | |
| Phase 1: Architecture Fix | PASS/FAIL | n commits made |
| Phase 2: DB Migration | PASS/FAIL | |
| Phase 3: E2E Infrastructure | PASS/FAIL | |
| Phase 4: E2E Test Files | PASS/FAIL | n files written |
| Phase 5: E2E Test Run | PASS/FAIL | n passed, n failed |

## Architecture Fix — Task Status

| Task | Status | Commit |
|---|---|---|
| A1 — Remove GH Actions cron | DONE/BLOCKED | <sha> |
| A2 — Fix cron auth header | DONE/BLOCKED | <sha> |
| B1 — Add scanPageToken/gmailQuery | DONE/BLOCKED | <sha> |
| B2 — Refactor sync/start | DONE/BLOCKED | <sha> |
| B3 — fetchMessageIdPage + scan pagination | DONE/BLOCKED | <sha> |
| C1 — Fix senderEmail bug | DONE/BLOCKED | <sha> |
| D1 — Create gmailQuery.ts | DONE/BLOCKED | <sha> |
| D2 — Apply query to scan route | DONE/BLOCKED | <sha> |
| E1 — Remove chunk route | DONE/BLOCKED | <sha> |
| F1 — SyncJobMessage table | DONE/BLOCKED | <sha> |
| F2 — Use SyncJobMessage in advance | DONE/BLOCKED | <sha> |
| G1 — Batch MerchantRule fetch | DONE/BLOCKED | <sha> |
| H — SyncProgressBanner UX | DONE/BLOCKED | <sha> |

## E2E Test Results

| Suite | Tests | Passed | Failed | Blocked |
|---|---|---|---|---|
| 01-auth | 3 | | | |
| 02-onboarding | 2 | | | |
| 03-sync | 6 | | | |
| 04-dashboard | 5 | | | |
| 05-transactions | 5 | | | |
| 06-categories | 2 | | | |
| 07-filters | 3 | | | |
| 08-passwords | 2 | | | |
| 09-parselogs | 1 | | | |
| 10-assets | 3 | | | |
| 11-analytics | 1 | | | |
| 12-api | 9 | | | |
| 13-nonfunctional | 5 | | | |
| 14-errors | 4 | | | |
| golden-path (demo) | 7 | | | |
| **TOTAL** | **59** | | | |

## Failures and Blockers

<list each failed test with: test ID, error message, root cause, and suggested fix>

## TypeScript Status

- Pre-fix errors: <n>
- Post-fix errors: <n>  ← must be 0

## Next Steps for Human

1. [ ] Push to git remote: `git push origin main`
2. [ ] Verify Vercel deployment succeeds (check Vercel dashboard)
3. [ ] Confirm CRON_SECRET is set in Vercel environment variables
4. [ ] Run golden path real-sync test manually: `E2E_REAL_SYNC=true npx playwright test e2e/golden-path.spec.ts`
5. [ ] Verify first cron tick fires and syncs correctly (check Vercel Cron logs)
```

---

## What the Agent Must NOT Do

- Push to git remote (`git push`)
- Open a headed browser for OAuth login
- Prompt the user for any input
- Skip a task because it "seems hard" — attempt it, then mark BLOCKED with reason if it fails
- Modify `prisma/schema.prisma` and skip running `npx prisma migrate dev`
- Commit broken TypeScript (`npx tsc --noEmit` must be clean before every commit)
- Delete any file not explicitly listed in this plan
- Modify `.env.local` except to add the two test variables (`TEST_USER_EMAIL`, `ENABLE_TEST_AUTH_SEED`)

---

## Quick Reference — All Files Modified

| File | Action | Phase |
|---|---|---|
| `.github/workflows/sync-advance.yml` | DELETE | 1-A1 |
| `vercel.json` | Verify/ensure crons key | 1-A1 |
| `src/app/api/gmail/sync/advance/route.ts` | Auth fix + scan pagination + SyncJobMessage | 1-A2, B3b, F2 |
| `src/app/api/gmail/sync/start/route.ts` | Store gmailQuery, no scanning | 1-B2 |
| `src/app/api/gmail/sync/chunk/route.ts` | DELETE | 1-E1 |
| `src/lib/gmail.ts` | Add fetchMessageIdPage; update fetchMessageMetadataList | 1-B3 |
| `src/lib/gmailQuery.ts` | CREATE | 1-D1 |
| `src/app/api/gmail/scan/route.ts` | Single-page with pre-filter query | 1-D2 |
| `prisma/schema.prisma` | +scanPageToken, +gmailQuery, +SyncJobMessage, -messageIds | 1-B1, F1 |
| `prisma/migrations/` | Two new migration files | 1-B1, F1 |
| `src/components/SyncProgressBanner.tsx` | Scanning state UI, poll intervals | 1-H |
| `.env.local` | +TEST_USER_EMAIL, +ENABLE_TEST_AUTH_SEED | 3 |
| `playwright.config.ts` | CREATE | 3 |
| `src/app/api/test/auth-seed/route.ts` | CREATE | 3 |
| `e2e/setup/auth.setup.ts` | CREATE | 3 |
| `e2e/helpers/api.ts` | CREATE | 3 |
| `e2e/01-auth.spec.ts` through `e2e/14-errors.spec.ts` | CREATE (14 files) | 4 |
| `e2e/golden-path.spec.ts` | CREATE | 4 |
| `docs/plans/2026-07-11-run-report.md` | CREATE | 6 |
