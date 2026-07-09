# Financial Manager — Design Specification

**Date:** 2026-07-09  
**Status:** Approved  
**Author:** Brainstorming session with Claude

---

## 1. Context

The goal is a personal financial manager web app that automatically tracks expenses, income, and assets for 2–10 users (personal use first, with a path to commercialization). The core problem it solves: most people do not track their finances because manual entry is tedious. By reading Gmail with Google OAuth, the app captures transactions automatically with zero manual effort — the same approach used by CRED and Walnut.

---

## 2. Vision

A clean, Apple-style financial dashboard that:
- Reads your Gmail to auto-capture every transaction (expenses, income, subscriptions)
- Categorizes them using an LLM (Gemini 1.5 Flash)
- Visualizes spending trends daily / weekly / monthly / yearly
- Shows month-on-month and year-on-year comparisons with semantically correct delta badges
- Lets you manually track assets and calculate net worth
- Works beautifully on both desktop and mobile browsers
- Costs $0/month for up to 10 users

---

## 3. Decisions Made

| Decision | Choice | Reason |
|---|---|---|
| Platform | Web app (PWA) | No app store, works on all devices |
| Framework | Next.js 14 (App Router) | Full-stack in one codebase, native Vercel deployment |
| Styling | Tailwind CSS | Rapid responsive design, mobile + desktop |
| Auth | NextAuth.js + Google OAuth | Multi-user, each user signs in with their own Google account |
| Gmail access | Gmail API (readonly scope) | Auto-capture transactions from bank/merchant emails |
| LLM | Gemini 2.5 Flash (`gemini-flash-latest` alias) | Free tier: 1,500 req/day — covers steady state (200/day for 10 users) and single-user retro sync (900 calls/day) comfortably |
| Database | Neon PostgreSQL (serverless) | Free tier: 0.5GB — enough for years of personal data |
| ORM | Prisma | Type-safe queries, schema migrations |
| Hosting | Vercel | Free tier, zero-config Next.js, 100K API calls/month |
| Retro data | 6-month Gmail lookback on first sync | Gmail API supports `after:` date filter |
| Theme | Light, pastel palette, Apple-style | Clean, no dark mode for V1 |
| Charts | Recharts | Lightweight, composable, works with React |
| Icons | Custom SVG icon pack (Feather-style) | No emojis, consistent stroke weight |

---

## 4. Google Auth & Gmail Access Flow

### Authentication flow (single OAuth consent)

```
User visits app (unauthenticated)
      → Redirected to /login
      → Clicks "Continue with Google"
      → Google OAuth consent screen
            Scopes requested in one flow:
            - openid email profile  (identity — who you are)
            - https://www.googleapis.com/auth/gmail.readonly  (read emails)
      → User approves both scopes
      → Google redirects to /api/auth/callback/google
      → NextAuth:
            - Creates User row (email, name, avatar)
            - Stores access_token + refresh_token in Account table
            - Sets session cookie
      → Redirected to /onboarding (first time) or / (returning user)
```

### Token lifecycle

- `access_token` expires after 1 hour — NextAuth auto-refreshes using the stored `refresh_token`
- `refresh_token` is long-lived (until user revokes access in Google Account settings)
- Gmail sync always uses a fresh access token — no re-authentication needed
- User can disconnect Google at any time via Settings → revokes tokens and clears stored credentials

### Non-Gmail users (Yahoo, Outlook, iCloud)

- **V1:** Gmail only. Stated clearly on the login page: *"Financial Manager connects to Gmail to auto-capture transactions. A Gmail account is required."*
- A "Request your email provider" link on the login page captures demand for future providers
- **V2 roadmap:** IMAP-based connection for Yahoo, Outlook, iCloud — same parsing pipeline, different email fetching layer

### First-time onboarding — scan, review, then import

After first login the user goes through a three-step onboarding flow before any LLM calls are made.

**Step 1 — Choose lookback period**

```
"How far back should we scan your Gmail?"

  ○  Last 1 month
  ○  Last 3 months
  ● Last 6 months  (recommended)
  ○  Custom date  [date picker]

  [Scan My Gmail →]
```

- Selected date stored as `syncFromDate` on the User row

**Step 2 — Dry-run scan (free, no LLM)**

```
POST /api/gmail/scan
  → Gmail API: fetch metadata only (sender, subject, date) for all emails
    after syncFromDate — no email bodies fetched yet
  → For each email: run EmailFilter matching (sender domain/email + subject keywords)
  → Classify into two buckets:
      AUTO-APPROVED  — matched a known filter with high confidence
      NEEDS REVIEW   — partial keyword match, low email count, or unknown domain
  → Return grouped summary (no DB writes yet)
```

The scan fetches metadata only — no email bodies, no LLM calls, zero cost beyond Gmail API quota (which is free).

**Step 3 — "Review what we found" screen**

```
┌──────────────────────────────────────────────────────────┐
│  We scanned 1,840 emails · Found 312 likely financial    │
│  emails from 24 senders                                  │
│                                                          │
│  AUTO-APPROVED  18 senders                    [expand]   │
│    hdfcbank.com           · 47 emails                    │
│    swiggy.in              · 23 emails                    │
│    axisbank.com           · 18 emails  ...               │
│                                                          │
│  NEEDS YOUR REVIEW  6 senders                            │
│    noreply@icicilombard.com  · 8 emails    [✓ Keep] [✗]  │
│    alerts@phonepe.com        · 12 emails   [✓ Keep] [✗]  │
│    noreply@hdfclife.com      · 3 emails    [✓ Keep] [✗]  │
│    ...                                                   │
│                                                          │
│  [Start Importing →]                                     │
└──────────────────────────────────────────────────────────┘
```

- Auto-approved senders are inserted into `EmailFilter` as `isActive: true`
- User approves or rejects each "needs review" sender — approved ones added to `EmailFilter`, rejected ones saved as `isActive: false` (never surfaced again)
- "Start Importing" begins the chunked sync using only emails from approved senders
- On all future syncs, only emails newer than `lastMessageId` are fetched
- User can retrigger the scan from Settings to re-import with updated filters (processes only unprocessed emails — those with no existing `gmailMsgId` record)

### Retro retrigger

When filter rules improve (new senders added), the user can retrigger from Settings:

```
POST /api/gmail/scan?retrigger=true
  → Same dry-run scan as onboarding
  → Shows only NEW senders not previously seen
  → User approves → sync processes only emails with no existing gmailMsgId
  → Already-imported emails are never re-parsed
```

Dry-run mode is also available before triggering: "Show me what new emails would be picked up — without importing yet." This lets the user validate a new filter before committing LLM calls.

---

## 5. Architecture

```
Browser (Next.js PWA)
      │
      ├── /app (React pages + layouts)
      │     ├── / → Dashboard
      │     ├── /onboarding → Scan · Review · Import flow (first login only)
      │     ├── /transactions → Transaction list + review queue
      │     ├── /analytics → Charts & reports
      │     ├── /assets → Asset management
      │     └── /settings → Categories, Gmail filters, LLM config
      │
      ├── /api (Next.js API routes — server-side)
      │     ├── /auth/[...nextauth] → Google OAuth
      │     ├── /gmail/scan → Dry-run: fetch metadata, classify senders, return summary
      │     ├── /gmail/sync/start → Create SyncJob, return jobId
      │     ├── /gmail/sync/chunk → Process next N emails (LLM + DB write), update SyncJob
      │     ├── /gmail/sync/status → Return SyncJob progress (polled by client)
      │     ├── /gmail/reconcile → Parse statement email, write ReconciliationLog
      │     ├── /transactions → CRUD
      │     ├── /analytics → Aggregated SQL queries
      │     ├── /assets → CRUD
      │     ├── /filters → EmailFilter CRUD (admin)
      │     └── /export → CSV generation
      │
      └── Prisma ORM
            │
            └── Neon PostgreSQL (cloud, user-isolated by user_id)
```

### Data flow — Gmail sync (chunked polling)

The sync runs as a client-driven loop so every server call stays within Vercel's 10-second free-tier function limit:

```
User clicks "Sync Gmail" (or completes onboarding review)
  → POST /api/gmail/sync/start
      → Creates SyncJob { status: "running", totalEmails: N, processedEmails: 0 }
      → Returns { jobId }

Client loop (every 2 seconds):
  → POST /api/gmail/sync/chunk?jobId=xxx
      → Fetch next 15 emails from Gmail (sender matches active EmailFilters only)
      → Skip emails with existing gmailMsgId (Layer 1 dedup)
      → For each remaining email → Gemini 1.5 Flash (parse transaction)
      → Apply fingerprint dedup + source priority (Layers 2 & 3)
      → Write transactions to DB, update SyncJob.processedEmails
      → Returns { processed: 15, newTransactions: 8, done: false }
  → GET /api/gmail/sync/status?jobId=xxx
      → Returns { processedEmails, totalEmails, newTransactions, status }
      → Client updates progress bar

  Repeat until done: true
  → SyncJob.status = "complete"
  → User sees summary: "Imported 247 transactions from 6 months"

Chunk size: 15 emails · ~0.5s per LLM call · ~7–8s per chunk · safely within 10s limit
```

### Statement reconciliation flow

Statements are not parsed for real-time transactions. They are used for audit only:

```
User uploads or syncs a statement email
  → POST /api/gmail/reconcile
  → LLM extracts all line items from statement
  → Each line item compared against existing Transaction records for that period
  → Writes ReconciliationLog rows: matched | missing | mismatch
  → User sees reconciliation report in Settings → "Audit" tab
  → Missing transactions surfaced as suggestions to add manually or via filter improvement
```

### Multi-tenancy

- Every DB table has a `user_id` column
- All API routes extract `user_id` from the NextAuth session
- No user can read another user's data — enforced at the API layer
- Each user authorizes their own Gmail via Google OAuth (separate refresh tokens stored per user)
- `EmailFilter` table is global (shared across users) — maintained by the app, not per-user
- **LLM rate limit:** Gemini free tier is 1,500 req/day per API key. A single user's retro sync (~900 emails) completes in one day. Multi-user onboarding should be staggered — do not onboard all 10 users simultaneously or the daily limit will be shared across concurrent syncs

---

## 6. Transaction Deduplication

A single real-world payment can appear in multiple emails — Swiggy order confirmation, GPay receipt, bank debit alert, and month-end statement. The pipeline uses four layers to ensure each transaction is stored exactly once.

### Layer 1 — EmailFilter pre-screening (before LLM)

Before any email reaches the LLM, it is checked against the `EmailFilter` table:

```typescript
function matchesFilter(email: EmailMetadata, filters: EmailFilter[]): boolean {
  return filters.some(f => {
    if (f.type === 'sender_email') return email.from === f.value
    if (f.type === 'sender_domain') return email.from.endsWith('@' + f.value)
    if (f.type === 'subject_keyword') return email.subject.toLowerCase().includes(f.value)
    return false
  })
}
```

Only emails matching at least one active filter are fetched in full and sent to the LLM. All others are skipped. This is the primary cost-control mechanism.

### Layer 2 — Gmail message ID dedup

Every processed email is stored with its Gmail message ID (`gmailMsgId`). The `@@unique([userId, gmailMsgId])` constraint is the first gate: replaying the same sync call never re-inserts any email. Re-triggers only process emails with no existing `gmailMsgId` record.

### Layer 3 — Transaction fingerprint

After LLM extraction, a deterministic fingerprint is computed:

```typescript
function buildFingerprint(merchant: string, amount: number, date: Date): string {
  const normalizedMerchant = merchant.toLowerCase().replace(/[^a-z0-9]/g, '')
  const dateBucket = Math.floor(date.getTime() / (2 * 24 * 60 * 60 * 1000)) // 2-day bucket
  return `${normalizedMerchant}|${amount}|${dateBucket}`
}
```

The `@@unique([userId, fingerprint])` constraint rejects any transaction whose (merchant, amount, 2-day window) tuple already exists for that user. This catches the same payment extracted from different emails.

### Layer 4 — Source priority ranking

When Layer 3 detects a fingerprint collision, the new record replaces the existing one only if it comes from a higher-priority source. Source rank is derived from the `EmailFilter` record that matched the sender — each filter has a `sourceRank` field set when the filter is created:

| Rank | Source type | Example senders |
|---|---|---|
| 1 (highest) | Bank debit / credit alert | HDFC, SBI, ICICI, Axis |
| 2 | Payment gateway receipt | GPay, PhonePe, Amazon Pay, Paytm |
| 3 | Merchant confirmation | Swiggy, Zomato, Amazon, Flipkart |

If a rank-1 record already exists, any rank-2/3 duplicate for the same fingerprint is silently discarded. If a lower-ranked record exists and a higher-ranked one arrives, the existing record is updated.

### User review queue

Transactions with `needsReview: true` appear in a dedicated queue in the Transactions page. A transaction is flagged when:
- LLM `confidence < 0.7`
- Layer 3/4 resolved a fingerprint conflict

The user can approve (keep), edit (correct fields), or dismiss (delete) each queued item.

---

## 7. Database Schema

```prisma
model User {
  id             String        @id @default(cuid())
  email          String        @unique
  name           String?
  image          String?
  syncFromDate   DateTime?     // user-selected retro start date
  gmailSyncedAt  DateTime?
  lastMessageId  String?       // last Gmail message ID processed
  createdAt      DateTime      @default(now())
  transactions   Transaction[]
  assets         Asset[]
  categories     Category[]
  accounts       Account[]     // NextAuth
  sessions       Session[]     // NextAuth
  syncJobs       SyncJob[]
  reconLogs      ReconciliationLog[]
}

model Transaction {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  gmailMsgId  String?            // unique per user via @@unique([userId, gmailMsgId])
  fingerprint String?            // dedup key: normalized(merchant)|amount|date_bucket
  date        DateTime
  merchant    String
  amount      Float              // always positive
  type        String             // "expense" | "income"
  currency    String   @default("INR")
  category    String
  tag         String?
  source      String   @default("gmail")  // "gmail" | "manual"
  sourceRank  Int      @default(0)        // 1=bank, 2=gateway, 3=merchant
  reviewed    Boolean  @default(false)
  needsReview Boolean  @default(false)
  createdAt   DateTime @default(now())

  @@unique([userId, gmailMsgId])
  @@unique([userId, fingerprint])
}

model Asset {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  name      String
  type      String   // "savings" | "fd" | "mutual_fund" | "stocks" | "property" | "gold" | "other"
  value     Float
  currency  String   @default("INR")
  asOf      DateTime
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Category {
  id        String  @id @default(cuid())
  userId    String
  user      User    @relation(fields: [userId], references: [id])
  name      String
  icon      String  // icon key from icon pack
  color     String  // pastel hex
  isDefault Boolean @default(false)
}

// Global sender allowlist — shared across all users, maintained by the app
model EmailFilter {
  id         String   @id @default(cuid())
  type       String   // "sender_domain" | "sender_email" | "subject_keyword"
  value      String   // e.g. "hdfcbank.com" | "alerts@axisbank.com" | "debited"
  sourceRank Int      @default(3)   // 1=bank, 2=gateway, 3=merchant — used for dedup priority
  isActive   Boolean  @default(true)
  addedAt    DateTime @default(now())
  note       String?  // why this filter was added, e.g. "added after user reported miss"

  @@unique([type, value])
}

// Tracks progress of a chunked Gmail sync job
model SyncJob {
  id                String   @id @default(cuid())
  userId            String
  user              User     @relation(fields: [userId], references: [id])
  status            String   @default("running")  // "running" | "complete" | "failed"
  totalEmails       Int      @default(0)
  processedEmails   Int      @default(0)
  newTransactions   Int      @default(0)
  skippedEmails     Int      @default(0)
  isRetrigger       Boolean  @default(false)
  startedAt         DateTime @default(now())
  completedAt       DateTime?
}

// Audit log from statement reconciliation — source of truth comparison
model ReconciliationLog {
  id                    String   @id @default(cuid())
  userId                String
  user                  User     @relation(fields: [userId], references: [id])
  statementGmailMsgId   String   // the statement email that was parsed
  statementDate         DateTime // date on the statement line item
  statementMerchant     String
  statementAmount       Float
  matchedTransactionId  String?  // null if no match found
  status                String   // "matched" | "missing" | "mismatch"
  mismatchDetails       String?  // e.g. "amount differs: statement=500, captured=450"
  resolvedAt            DateTime?
  createdAt             DateTime @default(now())
}
```

---

## 8. Screens

### 8.0 Onboarding (first login only)

**Route:** `/onboarding`

Three-step flow, shown only once after first Google OAuth login:

**Step 1 — Lookback picker:** Date range selector (1 month / 3 months / 6 months / custom). Confirm button triggers dry-run scan.

**Step 2 — Scanning state:** Progress indicator while Gmail metadata is fetched. No LLM calls. "Scanning your Gmail..." with email count incrementing live.

**Step 3 — Review what we found:**
- Summary card: total emails scanned · financial emails found · sender count
- "Auto-approved" section (collapsed by default, expandable): list of senders with email count — these are already in `EmailFilter`
- "Needs your review" section: each sender shown with sample subject lines, email count, and [Keep] / [Skip] toggle
- "Start Importing" button — disabled until user has reviewed all pending senders
- Progress bar replaces button once import begins, showing live chunk progress

### 8.1 Dashboard (Home)

**Layout:** Icon sidebar (desktop) · bottom tab bar (mobile)

**Components:**
- Greeting + subtitle (period selector · Sync Gmail button)
- KPI row (3 cards): Net Worth · Income · Spent
  - Each card shows current value + semantic delta badge vs last month
- MoM / YoY comparison strip (4 cells): Last month spend · 6-month avg · YoY spend · Saved this month
- Grouped bar chart: Income vs Expenses per month (6-month view), with Weekly / Monthly / Yearly toggle
- Category donut chart: Spending breakdown by category
- Recent transactions feed (last 5): icon · merchant · category · date · amount · Auto badge

**Badge logic (semantically correct):**
- Green: Net worth up · Income up · Expenses down · Savings up · YoY spend down
- Red: Net worth down · Income down · Expenses up · Savings down · YoY spend up
- Grey: No change · Reference values · 6-month averages

### 8.2 Transactions

**Components:**
- Review queue banner (shown when `needsReview` count > 0): "X transactions need your review" → links to filtered view
- Search bar + filters (date range, category, type: income/expense)
- Full paginated transaction list
- Inline category edit (click to change)
- Tag transactions
- Mark as reviewed toggle
- Sort by date / amount / category

### 8.3 Analytics & Reports

**Components:**
- Period toggle: Daily / Weekly / Monthly / Yearly
- Bar chart: Spending over time
- Line chart: Income vs Expense trend
- Category breakdown: Pie / bar toggle
- MoM table: Current month vs last month per category (with % delta, semantic color)
- YoY table: Current year vs last year per month
- Export button: CSV

### 8.4 Assets & Net Worth

**Components:**
- Net worth total (sum of all assets)
- Net worth timeline chart (how it changes month by month as user updates values)
- Asset allocation donut
- Asset list: Add / edit / delete
  - Fields: Name, Type, Value, As-of date
  - Types: Savings account, FD, Mutual Fund, Stocks, Property, Gold, Other
- Per-asset value history (editable snapshots over time)

### 8.5 Settings

**Components:**
- Google account connected (avatar, email, disconnect option)
- Gmail sync: manual sync button + last synced timestamp
- **Email filters tab:** full list of active `EmailFilter` entries — add, toggle active/inactive, view note. No code deploy needed — changes take effect on next sync
- **Retrigger tab:** "Re-scan Gmail with updated filters" button → dry-run first, then shows new senders found, then imports unprocessed emails only
- **Audit tab:** ReconciliationLog report — missing / mismatched transactions surfaced from statement comparison
- Category manager: add, rename, delete, assign icon + color from icon pack
- LLM config: Gemini API key input, option to switch provider (Gemini / OpenRouter / Ollama URL)
- Export all data (CSV dump of all transactions)
- Danger zone: Delete all my data

---

## 9. Category Icon Pack

16 built-in SVG icons (Feather-style, 18px stroke-width 1.8):

| Key | Label | Pastel Color |
|---|---|---|
| food | Food | #fde8d8 / orange |
| cafe | Cafe | #fde8d8 / orange |
| transport | Transport | #ddf0e8 / green |
| metro | Metro / Train | #ddf0e8 / green |
| shopping | Shopping | #fdf0d8 / amber |
| clothing | Clothing / Myntra | #fdf0d8 / amber |
| bills | Bills & Utilities | #eee8fc / purple |
| phone | Phone / Telecom | #eee8fc / purple |
| health | Health & Medical | #e8f4fc / blue |
| learning | Books & Learning | #e8f4fc / blue |
| ott | OTT / Streaming | #f0fce8 / mint |
| rent | Rent & Housing | #fce8e8 / red |
| personal | Personal Care | #fce8f4 / pink |
| investment | Investment | #e8f0e8 / sage |
| work | Work & Business | #e8f4fc / blue |
| other | Other | #f5f0e8 / sand |

---

## 10. LLM Prompt Design

The LLM receives only emails that have already passed the `EmailFilter` pre-screen. Its sole job is extracting the transaction fields — it does not classify senders, detect statements, or decide whether an email is financial.

**System prompt (sent once per session):**
```
You are a financial transaction parser. Extract structured data from bank and merchant emails.
Always return valid JSON. If a field cannot be determined, use null.
Never include explanations — only JSON.
```

**User prompt (per email):**
```
Extract the transaction from this email. Return JSON with these exact fields:
{
  "merchant": string,    // merchant or sender name
  "amount": number,      // positive number, no currency symbol
  "currency": string,    // ISO code e.g. "INR", "USD"
  "date": string,        // ISO 8601 date
  "type": "expense"|"income",
  "category": string,    // one of: food, transport, shopping, bills, health, investment, income, other
  "confidence": number   // 0.0 to 1.0
}

Email:
{email_body}
```

**Validation rules:**
- `confidence < 0.7` → set `needsReview: true` on the transaction
- `amount <= 0` → discard
- `date` unparseable → use email received date
- Missing `merchant` → use email sender name

**Statement reconciliation prompt (separate flow, `/api/gmail/reconcile`):**
```
This is a bank or credit card statement. Extract every transaction listed.
Return a JSON array where each item has:
{
  "date": string,      // ISO 8601
  "merchant": string,
  "amount": number,    // positive
  "type": "expense"|"debit"|"credit"|"income"
}
Return only the array. No explanations.

Statement:
{statement_body}
```

---

## 11. Badge Logic — Implementation Reference

```typescript
type BadgeVariant = 'good' | 'bad' | 'neutral'

function getBadgeVariant(
  metric: 'networth' | 'income' | 'expense' | 'savings' | 'yoy_spend',
  direction: 'up' | 'down' | 'unchanged'
): BadgeVariant {
  if (direction === 'unchanged') return 'neutral'

  const goodWhenUp = ['networth', 'income', 'savings']
  const goodWhenDown = ['expense', 'yoy_spend']

  if (goodWhenUp.includes(metric)) return direction === 'up' ? 'good' : 'bad'
  if (goodWhenDown.includes(metric)) return direction === 'down' ? 'good' : 'bad'

  return 'neutral'
}
```

---

## 12. Privacy & Security

- Gmail OAuth scope: `gmail.readonly` — read only, no send/delete permissions
- Google API policy: Gmail API data cannot be used to train models or serve ads
- LLM calls: Only the email body text is sent — never email headers, sender addresses, or user PII beyond what's in the body
- Gemini free tier: Google may use prompts for model improvement. For stricter privacy, user can supply their own Gemini API key on paid tier (data not used for training)
- All data is isolated by `user_id` — no cross-user data access possible
- NextAuth handles session security (JWT + CSRF protection)
- Neon PostgreSQL: data encrypted at rest and in transit (TLS)

---

## 13. Responsive Design

- **Desktop (≥1024px):** 68px icon sidebar, main content area, 2–3 column grid layouts
- **Tablet (768–1023px):** Sidebar collapses to icons only, single-column charts
- **Mobile (<768px):** Sidebar hidden, bottom tab bar (4 tabs: Home · Transactions · Analytics · Assets), full-width cards, stacked KPIs

---

## 14. Monetization Path (V2+)

| Tier | Price | Features |
|---|---|---|
| Free | $0 | 1 user, Gemini free tier, manual sync |
| Personal | $3/month | 1 user, auto daily sync, PDF export, priority LLM |
| Family | $8/month | Up to 5 users, shared dashboard view |
| Pro | $15/month | Unlimited users, budget goals, recurring detection, API access |

Payments via Stripe. Upgrade prompt shown when free tier limits are hit.

---

## 15. V1 Scope (this build)

**In:**
- Google OAuth login (multi-user)
- Onboarding: dry-run Gmail scan · "Review what we found" screen · sender approve/reject
- EmailFilter table (global, DB-managed, no deploy needed to update)
- Gmail sync: chunked polling with real-time progress bar
- 6-month lookback on first sync (user-selectable)
- LLM-powered transaction parsing (Gemini 1.5 Flash)
- Transaction deduplication (4 layers: filter pre-screen · gmailMsgId · fingerprint · source priority)
- Auto categorization with icon pack
- Income tracking (detected from Gmail)
- Statement reconciliation: parse statement → compare against captured transactions → ReconciliationLog
- Retrigger retro sync with updated filters (unprocessed emails only) + dry-run preview
- Review queue for low-confidence transactions
- Asset management (manual add/edit/delete)
- Dashboard with KPIs, MoM/YoY badges, bar chart, donut chart, recent transactions
- Transactions page (search, filter, inline edit category, review queue banner)
- Analytics page (daily/weekly/monthly/yearly, MoM table, YoY table)
- Assets page (net worth, allocation, timeline)
- Settings: email filters tab · retrigger tab · audit/reconciliation tab · categories · LLM key · export
- CSV export
- Responsive design (desktop + mobile)

**Out (V2):**
- Budget goals and alerts
- Recurring expense detection
- PDF export
- Push notifications
- Dark mode
- Stripe payments / paid tiers
- Multiple currency support
- Auto daily sync (cron)

---

## 16. Verification

After implementation, validate end-to-end:

**Onboarding & filter**
1. **Dry-run scan:** Complete Google OAuth → onboarding screen → click "Scan My Gmail" → metadata fetched, zero LLM calls, sender list returned with auto-approved and needs-review buckets
2. **Review screen:** Approve 2 senders, reject 1 → approved senders appear in `EmailFilter` table as `isActive: true` → rejected sender saved as `isActive: false`
3. **Import begins:** Click "Start Importing" → progress bar increments in real-time → completes without timeout errors

**Sync & deduplication**
4. **EmailFilter pre-screen:** Add a non-financial sender manually → confirm it is skipped during sync (no LLM call made for it)
5. **Dedup — same email re-synced:** Sync again → transaction count unchanged (Layer 2: gmailMsgId)
6. **Dedup — same payment in multiple emails:** Seed one Swiggy order email + one GPay receipt for same amount/date → only one transaction stored, higher-rank source wins (Layers 3 & 4)
7. **Review queue:** Seed an email producing `confidence < 0.7` → transaction flagged `needsReview: true` → appears in review queue banner on Transactions page

**Reconciliation & retrigger**
8. **Statement reconciliation:** Trigger `/api/gmail/reconcile` with a statement email → `ReconciliationLog` rows written → "missing" entry visible in Settings Audit tab
9. **Retrigger dry-run:** Add a new sender to `EmailFilter` → Settings → Retrigger → dry-run shows new unprocessed emails → confirm → only those emails imported, existing transactions untouched
10. **Filter update without deploy:** Add a new `EmailFilter` row via Settings UI → next sync picks it up immediately, no code change needed

**Core features**
11. **LLM parsing:** Check a known transaction (e.g., Swiggy email) → correct merchant, amount, category extracted
12. **Dashboard:** KPI badges show correct color (expense down → green, income down → red)
13. **MoM / YoY:** Switch period selector → values and badges update correctly
14. **Analytics:** Toggle Weekly / Monthly / Yearly → chart updates
15. **Assets:** Add an asset → net worth updates → appears in allocation donut
16. **Transactions:** Edit a category inline → persists on reload
17. **Export:** Download CSV → all transactions present, correct columns
18. **Responsive:** Resize browser to 375px → bottom tabs appear, sidebar hidden
19. **Multi-user:** Sign in as second Google account → sees only own transactions, own sync state
