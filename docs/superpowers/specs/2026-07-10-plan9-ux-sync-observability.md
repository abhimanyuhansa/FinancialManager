# Plan 9: UX Polish, Background Sync, Category Mapping & Observability

**Goal:** Eliminate seed-data confusion for fresh users, make retro Gmail sync survive browser close, add inline category mapping with merchant rules, expose transaction source emails, improve debit display, and instrument the entire parsing pipeline for debuggability.

**Architecture:** Six largely independent feature areas sharing two new DB models (`MerchantRule`, `StatementPassword`), one new audit model (`ParseLog`), a Vercel Cron endpoint, and a transaction slide-out panel. All features build on the existing Next.js 16 / Prisma 7 / Neon stack.

**Tech Stack:** Next.js 16, Prisma 7, Neon (PostgreSQL), NextAuth v5, Gemini Flash, pdf-parse, Vercel Cron, AES-256-GCM (Node.js `crypto` module).

---

## 1. Schema Changes

### 1.1 New models

```prisma
model MerchantRule {
  id           String   @id @default(cuid())
  userId       String
  merchantName String   // normalized: lowercase trimmed
  category     String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, merchantName])
}

model StatementPassword {
  id                String   @id @default(cuid())
  userId            String
  senderDomain      String   // e.g. "hdfcbank.com"
  encryptedPassword String   // AES-256-GCM, hex-encoded ciphertext:iv:authTag
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, senderDomain])
}

model ParseLog {
  id               String   @id @default(cuid())
  userId           String
  syncJobId        String
  gmailMsgId       String
  senderDomain     String
  emailDate        DateTime?
  bodyLengthRaw    Int      // original body length before truncation
  bodyLengthSent   Int      // length sent to Gemini (≤ 1500 per email)
  wasTruncated     Boolean  @default(false)
  batchSize        Int      @default(1) // how many emails were in this Gemini call
  outcome          String   // see Outcome enum below
  geminiConfidence Float?
  parsedMerchant   String?
  parsedAmount     Float?
  transactionId    String?  // FK to Transaction if inserted
  errorDetail      String?
  createdAt        DateTime @default(now())
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, syncJobId])
  @@index([userId, gmailMsgId])
  @@index([createdAt]) // for 30-day pruning
}
```

**ParseLog outcome values:**
- `inserted` — new transaction created
- `upgraded` — existing transaction replaced with higher-sourceRank version
- `skipped_duplicate` — fingerprint/gmailMsgId collision, no change
- `skipped_no_amount` — Gemini ran, returned null or amount ≤ 0
- `skipped_gemini_null` — Gemini returned null for entire batch item
- `skipped_filter` — email did not match any active EmailFilter
- `skipped_pdf_encrypted` — PDF attachment found but password-protected, no password stored
- `skipped_pdf_failed` — PDF parse error (corrupt, unsupported format)
- `failed_gemini_error` — Gemini API returned non-200 after retries

### 1.2 Changes to existing models

**Transaction:** Add `gmailMsgId` to all API `select` responses (already in schema, just not exposed in API).

**SyncJob:** Add `encryptedBlockedCount Int @default(0)` — count of emails skipped due to encrypted PDFs with no password. No other schema change.

**User:** Already has `MerchantRule`, `StatementPassword`, `ParseLog` relations — add them.

**seed.ts:** Change `source` from `"gmail"` to `"seed"` for all seeded transactions. Add `source` field check to seed upsert logic.

---

## 2. Feature 1 — Onboarding Splash Overlay

### 2.1 Trigger condition
Show overlay when: user has zero transactions where `source != "seed"`. Check once per session (store dismissed state in `sessionStorage`, not `localStorage` — reappears on next login).

### 2.2 Overlay behaviour
- Dashboard renders fully behind a `backdrop-blur-sm` + semi-transparent overlay
- Centered white card (max-w-md): Financial Manager logo, one-paragraph explanation of what the app does and how it works, two buttons: **Start Gmail Sync** (primary, navigates to `/onboarding`) and **Skip for now** (ghost, dismisses overlay)
- Overlay does not appear on `/onboarding` itself

### 2.3 Seed data handling
- `source="seed"` transactions are shown in the UI but with a `Demo` badge in the transactions list
- Analytics and dashboard KPIs exclude `source="seed"` transactions when any real transactions exist
- Settings → new **"Clear Demo Data"** button: calls `DELETE /api/transactions/demo` which deletes all `source="seed"` transactions for the user

---

## 3. Feature 2 — Background Sync (Vercel Cron + LLM Batching)

### 3.1 Cron endpoint
**`GET /api/gmail/sync/advance`** — no auth required (secured by `CRON_SECRET` header check matching env var).

Logic:
1. Find all `SyncJob` rows with `status="running"`, ordered by `startedAt ASC` (oldest first)
2. For each job, process one chunk (15 emails → 2 Gemini batch calls of 10+5)
3. Update `processedEmails`, `newTransactions`, `encryptedBlockedCount`
4. If `processedEmails >= totalEmails`: set `status="complete"`, `completedAt=now()`
5. After processing all jobs: prune `ParseLog` rows where `createdAt < now() - 30 days`

`vercel.json`:
```json
{
  "crons": [{ "path": "/api/gmail/sync/advance", "schedule": "*/15 * * * *" }]
}
```

Local dev: Settings page shows **"Advance Sync (dev)"** button that calls the same endpoint with the `CRON_SECRET` header. Only rendered when `NODE_ENV === "development"`.

### 3.2 LLM batching (10 emails per Gemini call)

Replace `parseEmailTransaction` (single) with `parseEmailBatch` (batch):

**Input:** Array of `{ emailIndex, body (≤1500 chars), senderName, fallbackDate }`

**Prompt returns:**
```json
[
  { "emailIndex": 0, "merchant": "Swiggy", "amount": 450, "currency": "INR", "date": "2026-07-08", "type": "expense", "category": "food", "confidence": 0.95 },
  { "emailIndex": 1, "merchant": null, "amount": null, ... }
]
```

**Per-item error isolation:** If any item in the array has `amount: null` or fails JSON parsing, that item is treated as `skipped_no_amount` — other items in the batch are unaffected.

**Body truncation:** Each email body truncated to 1,500 chars. `ParseLog.bodyLengthRaw` records original length, `wasTruncated` set to `true` if `raw > 1500`.

### 3.3 PDF attachment support

In `fetchFullMessage`: after extracting text body, also scan `payload.parts` for `mimeType: "application/pdf"`.

For each PDF part:
1. Fetch attachment bytes via `GET /gmail/v1/users/me/messages/{msgId}/attachments/{attachmentId}`
2. Attempt `pdf-parse(buffer)` — if succeeds, append extracted text to body (up to 3,000 additional chars)
3. If `pdf-parse` throws with password error: mark email as `skipped_pdf_encrypted`, increment `SyncJob.encryptedBlockedCount`, record sender domain
4. If `pdf-parse` throws with other error: mark as `skipped_pdf_failed`

Password-protected PDF retry flow: when user provides password via Settings → Statement Passwords:
1. Fetch the original Gmail message attachment again (token must still be valid)
2. Attempt `pdf-parse(buffer, { password })` 
3. If success: re-run Gemini on extracted text, upsert transaction, update ParseLog outcome to `inserted`
4. If failure: return error "Incorrect password"

### 3.4 MerchantRule override during sync

After Gemini returns category for a transaction, before writing to DB:
```
const rule = await prisma.merchantRule.findUnique({
  where: { userId_merchantName: { userId, merchantName: merchant.toLowerCase().trim() } }
})
if (rule) category = rule.category  // override Gemini's category
```

---

## 4. Feature 3 — Persistent Sync Progress Banner

### 4.1 Banner placement
Inside `AppLayout`, above `<main>`. Checks for active SyncJob on mount and polls every 30 seconds.

**New endpoint:** `GET /api/gmail/sync/active` — returns the most recent `SyncJob` for the user regardless of `status`. Response:
```json
{
  "jobId": "...",
  "status": "running" | "complete" | "failed",
  "totalEmails": 500,
  "processedEmails": 247,
  "newTransactions": 38,
  "encryptedBlockedCount": 3,
  "startedAt": "...",
  "completedAt": null
}
```

### 4.2 Banner states
- **Running:** Blue progress bar, "Importing Gmail transactions… 247 / 500 · 38 new transactions found"
- **Complete (no blocked):** Green banner, "Sync complete — 38 transactions imported" + dismiss button. Auto-dismiss after 10s.
- **Complete (with blocked):** Orange banner, "Sync complete — but 3 encrypted statements couldn't be read. [Enter passwords →]" links to Settings → Statement Passwords tab.
- **Failed:** Red banner, "Sync failed — [Retry]" button calls `/api/gmail/sync/start` again.
- **No active job:** Banner not rendered.

Banner dismissed state stored in `sessionStorage` keyed by `jobId` — reappears on next login until dismissed.

---

## 5. Feature 4 — Statement Passwords UI

### 5.1 New Settings tab: "Statement Passwords"
Lists all `StatementPassword` rows for the user + any sender domains with `skipped_pdf_encrypted` ParseLog entries that have no password yet.

### 5.2 API
- `GET /api/settings/statement-passwords` — list stored domains + pending encrypted domains
- `POST /api/settings/statement-passwords` — `{ senderDomain, password }` → encrypt + upsert `StatementPassword`, re-queue affected emails for processing
- `DELETE /api/settings/statement-passwords/[domain]` — remove stored password

### 5.3 Encryption
```typescript
// lib/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "crypto"

const KEY = Buffer.from(process.env.STATEMENT_ENCRYPTION_KEY!, "hex") // 32 bytes

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${encrypted.toString("hex")}:${iv.toString("hex")}:${authTag.toString("hex")}`
}

export function decrypt(stored: string): string {
  const [enc, iv, tag] = stored.split(":").map(s => Buffer.from(s, "hex"))
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")
}
```

`STATEMENT_ENCRYPTION_KEY` = 32 random bytes as hex string (64 hex chars). Added to `.env.local` and Vercel env vars.

---

## 6. Feature 5 — Transaction Slide-out Panel + Category Mapping

### 6.1 Slide-out panel
Triggered by clicking any transaction row. Renders as a fixed right-side panel (400px, full height, `z-50`, `translate-x` transition). Overlay dims the rest of the page (`bg-black/20`). Closed by clicking overlay or pressing Escape.

**Panel contents:**
- Merchant name + category icon (large)
- Amount (red for debit, green for income — no minus sign)
- Date + type badge
- **Category picker:** 4×4 grid of category chips. Clicking a different category shows the apply-scope selector.
- **Apply scope selector** (appears after category change): Two radio options — "Just this transaction" / "All [Merchant] transactions ([N] total)". Confirm button.
- **Source section:**
  - `gmailMsgId` present: "View source email ↗" link to `https://mail.google.com/mail/u/0/#all/{gmailMsgId}`
  - `source="seed"`: "Demo data" grey badge
  - `source="manual"` (future): "Manually added" grey badge

### 6.2 Category change API
**`PATCH /api/transactions/[id]/category`**
```json
{ "category": "food", "scope": "single" | "all_merchant" }
```

Logic for `scope="all_merchant"`:
1. `UPDATE transactions SET category='food' WHERE userId=? AND merchant=? (normalized)`
2. `UPSERT merchantRule { userId, merchantName, category }`
3. Return `{ updatedCount: N }`

Logic for `scope="single"`:
1. `UPDATE transactions SET category='food' WHERE id=?`
2. No MerchantRule change

### 6.3 Transactions API update
Add `gmailMsgId` and `source` to the `/api/transactions` GET response select.

---

## 7. Feature 6 — Debit Display (no minus sign)

### 7.1 Formatting rule
```typescript
// Everywhere amounts are displayed in UI:
const fmtAmount = (amount: number, type: string) => {
  const abs = Math.abs(amount)
  const formatted = abs >= 100000 ? `₹${(abs/100000).toFixed(1)}L`
    : abs >= 1000 ? `₹${(abs/1000).toFixed(1)}K`
    : `₹${abs}`
  return type === "income" ? `+${formatted}` : formatted
}

// Color class:
const amountColor = (type: string) => type === "income" ? "text-green-600" : "text-red-500"
```

### 7.2 Scope of change
- `src/app/(app)/transactions/page.tsx`
- `src/app/(app)/dashboard/page.tsx` (Recent Transactions list)
- New slide-out panel
- CSV export: **keep sign** (`-450.00` for debits) for spreadsheet compatibility — document this in export header comment

---

## 8. Feature 7 — ParseLog Observability UI

### 8.1 New Settings subtab: "Parse Logs"
Table showing `ParseLog` rows for the user. Columns: Date, Sender Domain, Outcome, Merchant (if parsed), Amount (if parsed), Truncated?, Gmail link.

Filters: by outcome, by date range, by sender domain.

**`GET /api/settings/parse-logs`** — paginated, 50/page, filterable.

### 8.2 Reprocess action
Each row with outcome `skipped_*` or `failed_*` has a "Reprocess" button (except `skipped_duplicate`). Calls:

**`POST /api/settings/parse-logs/[id]/reprocess`** — fetches original Gmail message, re-runs through current pipeline (respects updated MerchantRules, updated EmailFilters, current body limit).

### 8.3 30-day pruning
`/api/gmail/sync/advance` prunes `ParseLog` rows older than 30 days at the end of each cron run:
```sql
DELETE FROM ParseLog WHERE createdAt < NOW() - INTERVAL '30 days'
```

---

## 9. Out of Scope (explicitly excluded)

- Manual transaction entry (future plan)
- Recurring sync for new emails after retro sync completes (future — cron only processes `status="running"` jobs)
- Push notifications when sync completes
- Multi-account Gmail support
- Password-protected PDFs where the PDF itself is the email body (not an attachment)

---

## 10. File Map

| File | Action |
|------|--------|
| `prisma/schema.prisma` | Add `MerchantRule`, `StatementPassword`, `ParseLog`; add `encryptedBlockedCount` to `SyncJob`; add relations to `User` |
| `prisma/seed.ts` | Change seeded transaction `source` from `"gmail"` to `"seed"` |
| `prisma/migrations/` | New migration for schema changes |
| `src/lib/crypto.ts` | New — AES-256-GCM encrypt/decrypt |
| `src/lib/gemini.ts` | Replace `parseEmailTransaction` with `parseEmailBatch` (10-email batching) |
| `src/lib/gmail.ts` | Add PDF attachment fetching + `pdf-parse` extraction |
| `src/app/api/gmail/sync/advance/route.ts` | New — cron endpoint |
| `src/app/api/gmail/sync/active/route.ts` | New — active job status for banner |
| `src/app/api/gmail/sync/chunk/route.ts` | Update to use `parseEmailBatch`, write `ParseLog` rows, handle PDF outcomes |
| `src/app/api/transactions/route.ts` | Add `gmailMsgId`, `source` to select |
| `src/app/api/transactions/[id]/category/route.ts` | New — PATCH category + scope |
| `src/app/api/transactions/demo/route.ts` | New — DELETE seed data |
| `src/app/api/settings/statement-passwords/route.ts` | New — GET/POST |
| `src/app/api/settings/statement-passwords/[domain]/route.ts` | New — DELETE |
| `src/app/api/settings/parse-logs/route.ts` | New — GET paginated |
| `src/app/api/settings/parse-logs/[id]/reprocess/route.ts` | New — POST reprocess |
| `src/components/AppLayout.tsx` | Add SyncProgressBanner |
| `src/components/SyncProgressBanner.tsx` | New — persistent sync status banner |
| `src/components/TransactionPanel.tsx` | New — slide-out detail/edit panel |
| `src/app/(app)/dashboard/page.tsx` | Add onboarding splash overlay; fix debit display |
| `src/app/(app)/transactions/page.tsx` | Add slide-out panel, fix debit display, add gmailMsgId to type |
| `src/app/(app)/settings/page.tsx` | Add Statement Passwords tab, Parse Logs tab, Clear Demo Data button, Advance Sync (dev) button |
| `src/app/api/analytics/dashboard/route.ts` | Exclude `source="seed"` transactions from all KPIs when user has any real transactions |
| `vercel.json` | New — cron schedule |
| `.env.local` | Add `CRON_SECRET`, `STATEMENT_ENCRYPTION_KEY` |
| `tests/lib/gemini.test.ts` | Update for batch API |
| `tests/api/transactions-category.test.ts` | New — category PATCH tests |
| `tests/lib/crypto.test.ts` | New — encrypt/decrypt round-trip |
