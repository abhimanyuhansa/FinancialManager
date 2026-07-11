# Gmail Sync Redesign — Design Spec
**Date:** 2026-07-12  
**Status:** Approved — implementation plan written  
**Author:** Architecture session with Abhimanyu  

---

## Problem Statement

> As a user I want to track my Income and Expense without having to manually enter data. I want retro data for at least 6 months and want the solution to be free of cost, available to multiple users as a product, with real-time tracking.

### Specific Problems With the Current Design

| # | Problem | Impact |
|---|---------|--------|
| 1 | `*/15` Vercel Cron rejected on Hobby plan | **Build fails — app won't deploy** |
| 2 | Two separate flows (scan + sync) that are logically one | Broken onboarding, user never sees Flow 1 |
| 3 | Scan caps at 500 emails (one page, no pagination) | Missed transactions for heavy inboxes |
| 4 | Chunk size 15 emails/tick at 15-min cron interval | 10K emails = 667 days to complete |
| 5 | 1 HTTP call per email for full message fetch | 10K emails = 10K calls, hits timeout |
| 6 | Gemini batch size 10 — too small | 1000 Gemini calls for 10K emails — approaches daily limit |
| 7 | No lastSyncedAt watermark used for incremental sync | Always re-scans full date range |
| 8 | No rate-limit awareness or user feedback when limits hit | Silent failures |

---

## Architecture Overview

Three layers working together:

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: ONE SYNC STATE MACHINE                                │
│  user.lastSyncedAt = NULL  → first sync (user picks period)     │
│  user.lastSyncedAt = DATE  → incremental (DATE - 24h buffer)    │
│  Both paths → identical SyncJob → scan → process pipeline       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2: CLIENT-DRIVEN ADVANCE (live progress, tab open)       │
│  Browser polls /api/gmail/sync/advance every 5 seconds          │
│  Phase A – Scan:    1 Gmail list page (500 IDs) per tick        │
│  Phase B – Process: 50 full emails via Gmail Batch API per tick │
│  1 Gemini call per tick (all 50 emails in one batch request)    │
│  Tab closed → job suspended in DB, resumes when tab reopens     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3: DAILY VERCEL CRON (background safety net)             │
│  Schedule: 0 2 * * *  — valid on Hobby plan, zero cost          │
│  Picks up any incomplete or new-email jobs                      │
│  Same advance logic, 50 emails per run                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Detailed Flow

### A. Onboarding Flow (first-time user)

This is the **only** path that shows the sender preview. It runs once. After this, all subsequent syncs bypass it entirely.

```
1. User lands on /onboarding
   → Check user.lastSyncedAt
   → NULL: show Step 1 (period picker: 1m / 3m / 6m)

2. User picks period → clicks "Preview senders"
   → POST /api/gmail/scan  (unchanged in purpose)
   → Builds gmailQuery(fromDate)
   → Calls Gmail messages.list (paginated, ALL pages, not just 500)
   → For each page: fetches metadata only (From, Subject) in batches of 20
   → classifySenders() → returns autoApproved[], needsReview[]
   → Returns sender summary to browser

3. User sees sender list (Step 2)
   → Can approve/reject individual senders
   → "Skip preview" button: auto-approves all autoApproved, ignores needsReview
   → "Confirm" saves EmailFilter rows

4. POST /api/gmail/scan/confirm
   → Saves approved/rejected EmailFilters
   → Saves user.syncFromDate = buildScanFromDate(period)
   → Does NOT start sync yet — just saves preferences

5. POST /api/gmail/sync/start
   → Creates SyncJob { status: "scanning", gmailQuery, scanPageToken: null }
   → Returns { jobId } immediately

6. Browser enters LIVE SYNC UI (Step 3)
   → Polls /api/gmail/sync/advance every 5s
   → Shows live scan progress: "Scanning… 2,500 emails found so far"
   → Then live import progress: "Importing… 4,500 / 10,000 (45%)"
   → On complete: navigates to /dashboard
```

### B. Incremental Sync Flow (every subsequent sync)

```
1. User clicks "Sync" in Settings, OR
   Daily cron fires at 2am

2. POST /api/gmail/sync/start
   → user.lastSyncedAt IS NOT NULL
   → fromDate = lastSyncedAt - 24h  (24h buffer catches delayed emails)
   → Creates SyncJob { status: "scanning", gmailQuery, scanPageToken: null }
   → Returns { jobId } immediately
   → NO period picker, NO sender preview — goes straight to scanning

3. Scanning + processing: identical to onboarding flow
   → SyncProgressBanner shows progress at top of any page

4. On complete:
   → user.lastSyncedAt = job.completedAt
   → Dedup handles any overlapping emails from the 24h buffer
```

### C. The Advance Endpoint (the engine — both flows share this)

`GET /api/gmail/sync/advance` — called by client every 5s AND by daily cron

```
Auth check:
  Client call: requires valid session (user is logged in)
  Cron call:   requires Authorization: Bearer <CRON_SECRET>
  Both valid — same endpoint

Phase A — Scanning (job.status = "scanning"):
  1. Fetch one Gmail list page:
     messages.list?q=<gmailQuery>&maxResults=500&pageToken=<scanPageToken>
     → 1 API call, returns up to 500 message IDs + optional nextPageToken
  2. SyncJobMessage.createMany(page.messageIds, skipDuplicates: true)
  3. SyncJob.totalEmails = total SyncJobMessage count
  4. If nextPageToken: keep status="scanning", store new token
     If no nextPageToken: flip status="running" (scan complete)
  5. Return { phase: "scanning", scanned: N, hasMore: bool }

Phase B — Processing (job.status = "running"):
  1. Fetch next 50 unprocessed SyncJobMessage rows (processed=false)
  2. If 0 rows:
     → SyncJob.status = "complete", SyncJob.completedAt = now
     → user.lastSyncedAt = now
     → Return { phase: "complete" }
  3. Fetch all 50 full messages in ONE Gmail Batch API call:
     POST https://www.googleapis.com/batch/gmail/v1
     Body: multipart/mixed with 50 sub-requests (messages.get?format=full)
     → 1 HTTP call instead of 50
  4. For each fetched message:
     → Extract: senderEmail, senderDomain, senderName, body, date
     → Truncate body to 1500 chars
     → Check matchesEmailFilter(senderEmail, activeFilters)
     → Skip (log as skipped_filter) if no filter match
  5. Send all non-filtered messages in ONE Gemini batch call:
     parseEmailBatch(toProcess, apiKey)
     → 1 Gemini call per advance tick (regardless of how many pass filter)
  6. Check Gemini rate limit before calling:
     → Count today's Gemini calls from DB or in-memory counter
     → If >= 1400 (buffer before 1500 hard limit):
        return { phase: "rate_limited", resumesAt: tomorrow_midnight }
  7. Upsert parsed transactions (dedup by gmailMsgId + fingerprint)
  8. SyncJobMessage.updateMany({ processed: true }) for all 50
  9. Update SyncJob counters (processedEmails, newTransactions++)
  10. Return { phase: "running", processed: N, total: M, newTransactions: K }

Rate limit handling (both phases):
  → If Gmail returns 429: log, return { phase: "rate_limited", source: "gmail" }
  → If Gemini returns 429: log, return { phase: "rate_limited", source: "gemini" }
  → Client shows banner: "Processing paused — quota resets at midnight"
  → Client stops polling, resumes at midnight or when user dismisses + retries
```

---

## Gmail Batch API — Critical Implementation Detail

The Gmail Batch API allows 100 sub-requests per batch call. This is the key to making 50 emails/tick feasible within the 10s Vercel timeout.

**Request format:**
```
POST https://www.googleapis.com/batch/gmail/v1
Content-Type: multipart/mixed; boundary=batch_boundary
Authorization: Bearer <access_token>

--batch_boundary
Content-Type: application/http

GET /gmail/v1/users/me/messages/<id1>?format=full

--batch_boundary
Content-Type: application/http

GET /gmail/v1/users/me/messages/<id2>?format=full

--batch_boundary--
```

**Response:** multipart/mixed — one response body per sub-request.

This reduces 50 HTTP round trips (2.5–10s) to **1 HTTP round trip (~300–600ms)**, safely within the 10s timeout even with Gemini processing.

**Quota note:** Each sub-request still counts as 5 Gmail API units. But quota is per user's OAuth token (their Google account quota, not ours). For 10K emails: 50,000 units — trivial against the 1B/day user limit.

---

## Data Model Changes

### `SyncJob` — no changes needed

Current schema already has: `scanPageToken`, `gmailQuery`, `status`, `SyncJobMessage[]`.

### `User` — `lastSyncedAt` field

Already exists as `gmailSyncedAt` on the User model. **Rename to `lastSyncedAt`** for clarity, OR just use `gmailSyncedAt` as-is (verify it's being set on job completion — currently it is NOT being set).

Currently `gmailSyncedAt` is never written after a job completes. **This is the watermark bug.** Fix: set `user.gmailSyncedAt = job.completedAt` when status flips to "complete".

### New: `GeminiUsageLog` table (for rate limit tracking)

```prisma
model GeminiUsageLog {
  id        String   @id @default(cuid())
  date      String   // YYYY-MM-DD (UTC)
  callCount Int      @default(0)

  @@unique([date])
}
```

One row per calendar day. Increment on each Gemini call. Check before calling: if count >= 1400, pause and return rate_limited.

Alternatively: use an in-memory counter per serverless instance (simpler, but resets on cold start — could undercount). The DB approach is more reliable across cold starts.

---

## Client-Side Changes

### SyncProgressBanner

- **Scanning state:** "Scanning your Gmail… 2,500 emails found" (live count from `totalEmails`)
- **Running state:** progress bar with "Importing 4,500 / 10,000 · 127 transactions found"
- **Rate limited state:** amber banner "Processing paused — daily quota reached. Resumes at midnight." with manual retry button
- **Complete state:** green banner "Sync complete — 342 new transactions imported" (auto-dismiss 10s)
- **Poll interval:** 5s while scanning/running, 60s when idle

### Onboarding Page

- Step 1: Period picker (unchanged)
- Step 2: Sender preview — **add "Skip preview / sync everything" button** that auto-approves all autoApproved senders
- Step 3: Live sync progress (uses SyncProgressBanner inline or same polling)
- **"Delete all data" in Settings resets:** transactions, SyncJob, SyncJobMessage, sets `gmailSyncedAt = null` → forces full resync from period picker next time

### Settings Page — Manual Sync

- "Sync now" button visible when `lastSyncedAt` is not null
- Shows last sync time: "Last synced: 3 hours ago"
- Triggers incremental sync (no period picker, no preview)

---

## Cost Model (10 users, steady state)

| Resource | Free Limit | Usage | Status |
|---|---|---|---|
| Vercel Hobby cron (1/day) | 2 crons | 1 cron | ✅ |
| Vercel fn invocations | 100K/month | ~30K (5s poll × active users) | ✅ |
| Vercel fn runtime | 100 GB-hr | < 1 GB-hr | ✅ |
| Neon storage | 0.5 GB | ~150 MB for 2 years, 10 users | ✅ |
| Gmail API | User's own quota | Each user: 50K units for 10K emails | ✅ |
| Gemini Flash (OUR key) | 1,500 req/day | Initial sync: 200 calls/user. Ongoing: ~1/day/user | ✅ |
| Google Cloud Pub/Sub | — | Not used in this design | ✅ |

**Ongoing steady state (10 users, post initial sync):** ~10–30 Gemini calls/day total. Well within free tier.

**Initial sync bottleneck:** If all 10 users do their first sync on the same day and each has 10K emails: 10 × 200 = 2,000 Gemini calls. This hits the 1,500/day limit. The rate limit banner kicks in, users see a message, and processing resumes the next day automatically. Acceptable for a small product.

---

## What Gets Deleted / Refactored

| File | Action |
|---|---|
| `src/app/api/gmail/scan/route.ts` | Keep but fix: paginate through ALL pages, not just 500 |
| `src/app/api/gmail/sync/advance/route.ts` | Refactor: add Gmail Batch API, increase chunk to 50, add Gemini rate limit check, set `gmailSyncedAt` on complete, accept session auth (not just cron) |
| `src/app/api/gmail/sync/start/route.ts` | Add incremental path: if `gmailSyncedAt` exists, use `gmailSyncedAt - 24h` as fromDate, skip period picker |
| `src/lib/gmail.ts` | Add `fetchFullMessageBatch(accessToken, messageIds[])` using Gmail Batch API |
| `src/components/SyncProgressBanner.tsx` | Add rate_limited state, tighten poll to 5s |
| `src/app/(app)/onboarding/page.tsx` | Add "Skip preview" button; fix flow so it actually works end-to-end |
| `src/app/(app)/settings/page.tsx` | Add "Sync now" button + last synced time; add "Delete all data" that resets watermark |
| `prisma/schema.prisma` | Add `GeminiUsageLog` model |
| `vercel.json` | Change cron to `0 2 * * *` (fixes Hobby plan deployment) |

---

## Open Questions (for review)

1. **Session auth on advance endpoint:** Confirmed by code: the advance endpoint currently only accepts `Authorization: Bearer <CRON_SECRET>`. It has NO session auth. The client cannot currently call it directly. Fix: accept EITHER a valid session cookie (client-driven) OR the Bearer token (cron). When called via session, only process jobs belonging to that user. When called via cron, process all pending jobs.

2. **GeminiUsageLog granularity:** Track per-day global count (all users share the 1500 limit) or per-user? Since the API key is shared, it must be global. But for debugging it's useful to know which user consumed what. Recommendation: one global counter per day.

3. **Onboarding re-entry:** If a user closes the browser mid-onboarding (after scan/confirm but before sync starts), what happens when they return? They should be dropped into Step 3 (sync in progress) if a job exists, or back to Step 1 (period picker) if no job. The `lastSyncedAt = null` check handles this correctly.

---

## Success Criteria

- [ ] `vercel.json` cron `0 2 * * *` — deployment succeeds on Hobby plan
- [ ] First-time user: sees period picker → sender preview → live progress bar
- [ ] "Skip preview" button works — syncs without manually approving senders  
- [ ] Live progress updates every 5s with real email counts
- [ ] 10K email inbox: initial sync completes in ~17 minutes with tab open
- [ ] Tab closed mid-sync: progress resumes when user reopens app
- [ ] Daily cron picks up any incomplete jobs overnight
- [ ] Incremental sync uses `gmailSyncedAt - 24h` watermark
- [ ] Rate limit banner appears when Gemini quota is near
- [ ] "Delete all data" in Settings resets `gmailSyncedAt`, forces full resync
- [ ] Dedup prevents duplicate transactions on re-sync or overlap window
