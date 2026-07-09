# Financial Manager — Gmail Dry-Run Scanner + Onboarding UI Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gmail dry-run scanner API and the three-step onboarding UI (lookback picker → scanning state → review what we found), so a first-time user can scan their Gmail, review classified senders, approve/reject, and land at the import trigger — all with zero LLM calls and zero DB writes until the user explicitly approves.

**Architecture:** `/api/gmail/scan` fetches Gmail metadata only (no bodies), runs `matchesEmailFilter` against the DB filters, groups results into `autoApproved` and `needsReview` buckets, and returns JSON. The onboarding page manages a 3-step local state machine in a Client Component. Step 3 (review screen) lets users toggle each "needs review" sender; "Start Importing" writes approved senders to `EmailFilter` and marks the user's `syncFromDate`, then navigates to the sync flow (Plan 3). A `GET /api/gmail/token` helper retrieves the OAuth access token from the `Account` table for server-side Gmail calls.

**Tech Stack:** Next.js App Router API routes, Gmail REST API v1 (messages.list with metadata labelIds), Prisma 7, NextAuth v5 session, React useState (Client Component)

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/lib/gmail.ts` | Gmail API client — fetch message metadata list, fetch single message |
| Create | `src/app/api/gmail/token/route.ts` | GET — return current user's Gmail access token from Account table |
| Create | `src/app/api/gmail/scan/route.ts` | POST — dry-run scan: fetch metadata, classify, return summary |
| Create | `src/app/api/gmail/scan/confirm/route.ts` | POST — write approved senders to EmailFilter, set user.syncFromDate |
| Modify | `src/app/(app)/onboarding/page.tsx` | Replace stub with 3-step onboarding UI (Client Component) |
| Create | `src/components/onboarding/StepPicker.tsx` | Step 1 — lookback date picker |
| Create | `src/components/onboarding/StepScanning.tsx` | Step 2 — scanning state with live count |
| Create | `src/components/onboarding/StepReview.tsx` | Step 3 — review senders UI |
| Create | `tests/lib/gmail.test.ts` | Unit tests for Gmail metadata parsing helpers |
| Create | `tests/api/scan.test.ts` | Unit tests for scan classification logic |

---

### Task 1: Gmail token API route (TDD)

**Files:**
- Create: `src/app/api/gmail/token/route.ts`
- Create: `tests/api/token.test.ts`

The Gmail scan route needs an access token. This helper retrieves it from the `Account` table for the currently signed-in user.

- [ ] **Step 1: Write failing test**

```typescript
// tests/api/token.test.ts
jest.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findFirst: jest.fn(),
    },
  },
}));
jest.mock("@/lib/auth", () => ({
  auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { getGmailToken } from "@/lib/gmail";

const mockAuth = auth as jest.MockedFunction<typeof auth>;
const mockFindFirst = prisma.account.findFirst as jest.MockedFunction<typeof prisma.account.findFirst>;

describe("getGmailToken", () => {
  it("returns access_token when session and account exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "a@b.com" } } as never);
    mockFindFirst.mockResolvedValue({ access_token: "token-abc" } as never);

    const token = await getGmailToken("user-1");
    expect(token).toBe("token-abc");
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "google" },
      select: { access_token: true },
    });
  });

  it("returns null when no account found", async () => {
    mockFindFirst.mockResolvedValue(null);
    const token = await getGmailToken("user-1");
    expect(token).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/api/token.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/lib/gmail'`

- [ ] **Step 3: Create `src/lib/gmail.ts` with `getGmailToken`**

```typescript
// src/lib/gmail.ts
import { prisma } from "@/lib/prisma";

export async function getGmailToken(userId: string): Promise<string | null> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
    select: { access_token: true },
  });
  return account?.access_token ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/api/token.test.ts 2>&1 | tail -10
```

Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gmail.ts tests/api/token.test.ts
git commit -m "feat: add getGmailToken helper with tests"
```

---

### Task 2: Gmail metadata fetcher + scan classification logic (TDD)

**Files:**
- Modify: `src/lib/gmail.ts` (add `fetchMessageMetadata`, `classifySenders`)
- Create: `tests/lib/gmail.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/gmail.test.ts
import { classifySenders, buildScanFromDate } from "@/lib/gmail";

const filters = [
  { type: "sender_domain", value: "hdfcbank.com", sourceRank: 1, isActive: true },
  { type: "sender_email", value: "alerts@icicibank.com", sourceRank: 1, isActive: true },
  { type: "subject_keyword", value: "debited", sourceRank: 2, isActive: true },
];

const emails = [
  { id: "msg1", from: "noreply@hdfcbank.com", subject: "Your account debited", date: "2026-01-01" },
  { id: "msg2", from: "alerts@icicibank.com", subject: "Transaction alert", date: "2026-01-02" },
  { id: "msg3", from: "offers@spam.com", subject: "50% off today", date: "2026-01-03" },
  { id: "msg4", from: "bill@airtel.com", subject: "Your bill is ready", date: "2026-01-04" },
  { id: "msg5", from: "noreply@phonepe.com", subject: "Payment debited ₹500", date: "2026-01-05" },
];

describe("classifySenders", () => {
  it("marks filter-matched senders as autoApproved", () => {
    const result = classifySenders(emails, filters);
    const approvedSenders = result.autoApproved.map((s) => s.sender);
    expect(approvedSenders).toContain("noreply@hdfcbank.com");
    expect(approvedSenders).toContain("alerts@icicibank.com");
  });

  it("marks subject_keyword matches as needsReview (low confidence)", () => {
    const result = classifySenders(emails, filters);
    const reviewSenders = result.needsReview.map((s) => s.sender);
    expect(reviewSenders).toContain("noreply@phonepe.com");
  });

  it("excludes non-matching senders entirely", () => {
    const result = classifySenders(emails, filters);
    const allSenders = [
      ...result.autoApproved.map((s) => s.sender),
      ...result.needsReview.map((s) => s.sender),
    ];
    expect(allSenders).not.toContain("offers@spam.com");
    expect(allSenders).not.toContain("bill@airtel.com");
  });

  it("counts emails per sender correctly", () => {
    const multipleEmails = [
      ...emails,
      { id: "msg6", from: "noreply@hdfcbank.com", subject: "Another debit", date: "2026-01-06" },
    ];
    const result = classifySenders(multipleEmails, filters);
    const hdfc = result.autoApproved.find((s) => s.sender === "noreply@hdfcbank.com");
    expect(hdfc?.emailCount).toBe(2);
  });

  it("returns total email count", () => {
    const result = classifySenders(emails, filters);
    expect(result.totalScanned).toBe(5);
    expect(result.financialFound).toBe(3); // hdfc, icici, phonepe
  });
});

describe("buildScanFromDate", () => {
  it("returns date 1 month ago for '1m'", () => {
    const now = new Date("2026-07-09");
    const result = buildScanFromDate("1m", now);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(5); // June (0-indexed)
  });

  it("returns date 3 months ago for '3m'", () => {
    const now = new Date("2026-07-09");
    const result = buildScanFromDate("3m", now);
    expect(result.getMonth()).toBe(3); // April
  });

  it("returns date 6 months ago for '6m'", () => {
    const now = new Date("2026-07-09");
    const result = buildScanFromDate("6m", now);
    expect(result.getMonth()).toBe(0); // January
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/gmail.test.ts 2>&1 | tail -10
```

Expected: FAIL — `classifySenders` / `buildScanFromDate` not exported.

- [ ] **Step 3: Add `classifySenders` and `buildScanFromDate` to `src/lib/gmail.ts`**

```typescript
// Add to src/lib/gmail.ts (keep existing getGmailToken)

import { matchesEmailFilter } from "@/lib/emailFilter";

export type EmailMeta = {
  id: string;
  from: string;
  subject: string;
  date: string;
};

export type SenderSummary = {
  sender: string;
  domain: string;
  emailCount: number;
  sampleSubjects: string[];
  sourceRank: number;
  existsInFilter: boolean; // true if already in EmailFilter table
};

export type ScanResult = {
  totalScanned: number;
  financialFound: number;
  autoApproved: SenderSummary[];
  needsReview: SenderSummary[];
};

type FilterLike = {
  type: string;
  value: string;
  sourceRank: number;
  isActive: boolean;
};

export function classifySenders(emails: EmailMeta[], filters: FilterLike[]): ScanResult {
  // domain-only filters are high-confidence (autoApprove)
  // subject_keyword-only matches are low-confidence (needsReview)
  const domainFilters = filters.filter((f) => f.type !== "subject_keyword");
  const keywordFilters = filters.filter((f) => f.type === "subject_keyword");

  const senderMap = new Map<string, { emails: EmailMeta[]; sourceRank: number; confidence: "high" | "low" }>();

  for (const email of emails) {
    const domainMatch = matchesEmailFilter(email, domainFilters);
    const keywordMatch = matchesEmailFilter(email, keywordFilters);

    if (!domainMatch.matched && !keywordMatch.matched) continue;

    const rank = domainMatch.matched ? domainMatch.sourceRank : keywordMatch.matched ? keywordMatch.sourceRank : 3;
    const confidence: "high" | "low" = domainMatch.matched ? "high" : "low";

    const existing = senderMap.get(email.from);
    if (existing) {
      existing.emails.push(email);
      if (confidence === "high") existing.confidence = "high";
      if (rank < existing.sourceRank) existing.sourceRank = rank;
    } else {
      senderMap.set(email.from, { emails: [email], sourceRank: rank, confidence });
    }
  }

  const autoApproved: SenderSummary[] = [];
  const needsReview: SenderSummary[] = [];

  for (const [sender, data] of senderMap.entries()) {
    const domain = sender.split("@")[1] ?? sender;
    const summary: SenderSummary = {
      sender,
      domain,
      emailCount: data.emails.length,
      sampleSubjects: data.emails.slice(0, 3).map((e) => e.subject),
      sourceRank: data.sourceRank,
      existsInFilter: false,
    };
    if (data.confidence === "high") {
      autoApproved.push(summary);
    } else {
      needsReview.push(summary);
    }
  }

  return {
    totalScanned: emails.length,
    financialFound: autoApproved.length + needsReview.length,
    autoApproved,
    needsReview,
  };
}

export type LookbackPeriod = "1m" | "3m" | "6m";

export function buildScanFromDate(period: LookbackPeriod, now: Date = new Date()): Date {
  const d = new Date(now);
  const months = period === "1m" ? 1 : period === "3m" ? 3 : 6;
  d.setMonth(d.getMonth() - months);
  return d;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/gmail.test.ts 2>&1 | tail -10
```

Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gmail.ts tests/lib/gmail.test.ts
git commit -m "feat: add Gmail classifySenders and buildScanFromDate with tests"
```

---

### Task 3: Gmail message metadata fetcher

**Files:**
- Modify: `src/lib/gmail.ts` (add `fetchMessageMetadataList`)

This function calls the Gmail REST API to list messages (metadata only — no body). Used by the scan route.

- [ ] **Step 1: Add `fetchMessageMetadataList` to `src/lib/gmail.ts`**

```typescript
// Add to src/lib/gmail.ts

export type GmailMessageRef = {
  id: string;
  threadId: string;
};

export async function fetchMessageMetadataList(
  accessToken: string,
  afterDate: Date,
  pageToken?: string
): Promise<{ messages: EmailMeta[]; nextPageToken?: string }> {
  // Gmail "after:" filter uses Unix timestamp in seconds
  const afterSeconds = Math.floor(afterDate.getTime() / 1000);
  const params = new URLSearchParams({
    maxResults: "500",
    q: `after:${afterSeconds}`,
  });
  if (pageToken) params.set("pageToken", pageToken);

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`Gmail list failed: ${listRes.status} ${err}`);
  }

  const listData = await listRes.json() as { messages?: GmailMessageRef[]; nextPageToken?: string };
  const refs = listData.messages ?? [];

  // Fetch metadata (headers only) for each message in parallel, batched to avoid rate limits
  const BATCH = 20;
  const results: EmailMeta[] = [];

  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = refs.slice(i, i + BATCH);
    const metaBatch = await Promise.all(
      batch.map(async (ref) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!msgRes.ok) return null;
        const msg = await msgRes.json() as {
          id: string;
          payload?: { headers?: Array<{ name: string; value: string }> };
          internalDate?: string;
        };
        const headers = msg.payload?.headers ?? [];
        const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
        return {
          id: msg.id,
          from: get("From").replace(/.*<(.+)>/, "$1").trim(),
          subject: get("Subject"),
          date: get("Date") || (msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : ""),
        } satisfies EmailMeta;
      })
    );
    results.push(...metaBatch.filter((m): m is EmailMeta => m !== null));
  }

  return { messages: results, nextPageToken: listData.nextPageToken };
}
```

- [ ] **Step 2: Run all tests to verify nothing broken**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npm test 2>&1 | tail -10
```

Expected: all tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/gmail.ts
git commit -m "feat: add Gmail metadata list fetcher (headers only, no body, no LLM)"
```

---

### Task 4: Scan API route (`POST /api/gmail/scan`)

**Files:**
- Create: `src/app/api/gmail/scan/route.ts`

- [ ] **Step 1: Create the route directory and file**

```bash
mkdir -p src/app/api/gmail/scan
```

- [ ] **Step 2: Write `src/app/api/gmail/scan/route.ts`**

```typescript
// src/app/api/gmail/scan/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken, fetchMessageMetadataList, classifySenders, buildScanFromDate, LookbackPeriod } from "@/lib/gmail";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = await req.json() as { period?: LookbackPeriod };
  const period: LookbackPeriod = body.period ?? "6m";

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const fromDate = buildScanFromDate(period);

  // Fetch all message metadata (paginated)
  const allMessages = [];
  let pageToken: string | undefined;
  do {
    const page = await fetchMessageMetadataList(accessToken, fromDate, pageToken);
    allMessages.push(...page.messages);
    pageToken = page.nextPageToken;
  } while (pageToken);

  // Load active EmailFilters from DB
  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });

  // Classify senders
  const scanResult = classifySenders(allMessages, filters);

  // Mark existsInFilter for senders already in the DB (auto-approved ones are already there from seed)
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

- [ ] **Step 3: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/gmail/scan/route.ts
git commit -m "feat: add POST /api/gmail/scan dry-run endpoint"
```

---

### Task 5: Scan confirm API route (`POST /api/gmail/scan/confirm`)

**Files:**
- Create: `src/app/api/gmail/scan/confirm/route.ts`

This route receives the user's review decisions, writes new approved senders to `EmailFilter`, and stores `syncFromDate` on the `User` row.

- [ ] **Step 1: Write `src/app/api/gmail/scan/confirm/route.ts`**

```typescript
// src/app/api/gmail/scan/confirm/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { LookbackPeriod, buildScanFromDate } from "@/lib/gmail";

type ApprovedSender = {
  sender: string; // full email e.g. noreply@icicilombard.com
  domain: string;
  sourceRank: number;
};

type ConfirmBody = {
  period: LookbackPeriod;
  approvedSenders: ApprovedSender[]; // senders user kept from needsReview list
  rejectedSenders: string[];         // sender emails user skipped
};

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = await req.json() as ConfirmBody;
  const { period, approvedSenders, rejectedSenders } = body;

  // Write user-approved senders (from needsReview) into EmailFilter
  if (approvedSenders.length > 0) {
    await prisma.$transaction(
      approvedSenders.map((s) =>
        prisma.emailFilter.upsert({
          where: { type_value: { type: "sender_email", value: s.sender } },
          create: {
            type: "sender_email",
            value: s.sender,
            sourceRank: s.sourceRank,
            isActive: true,
            note: "User-approved during onboarding",
          },
          update: { isActive: true, sourceRank: s.sourceRank },
        })
      )
    );
  }

  // Write rejected senders as inactive (so they never resurface)
  if (rejectedSenders.length > 0) {
    await prisma.$transaction(
      rejectedSenders.map((sender) =>
        prisma.emailFilter.upsert({
          where: { type_value: { type: "sender_email", value: sender } },
          create: {
            type: "sender_email",
            value: sender,
            sourceRank: 3,
            isActive: false,
            note: "User-rejected during onboarding",
          },
          update: { isActive: false },
        })
      )
    );
  }

  // Store the user's chosen sync start date
  const syncFromDate = buildScanFromDate(period);
  await prisma.user.update({
    where: { id: userId },
    data: { syncFromDate },
  });

  return NextResponse.json({ ok: true, syncFromDate: syncFromDate.toISOString() });
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/gmail/scan/confirm/route.ts
git commit -m "feat: add POST /api/gmail/scan/confirm — writes approved senders and syncFromDate"
```

---

### Task 6: Onboarding UI — Step components (TDD for StepPicker logic)

**Files:**
- Create: `src/components/onboarding/StepPicker.tsx`
- Create: `src/components/onboarding/StepScanning.tsx`
- Create: `src/components/onboarding/StepReview.tsx`
- Create: `tests/lib/onboarding.test.ts`

- [ ] **Step 1: Write logic test for onboarding state (no React, pure logic)**

```typescript
// tests/lib/onboarding.test.ts
import { buildScanFromDate } from "@/lib/gmail";

describe("lookback period → date", () => {
  it("1m gives roughly 30 days ago", () => {
    const now = new Date("2026-07-09");
    const d = buildScanFromDate("1m", now);
    const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(28);
    expect(diffDays).toBeLessThanOrEqual(32);
  });

  it("6m gives roughly 180 days ago", () => {
    const now = new Date("2026-07-09");
    const d = buildScanFromDate("6m", now);
    const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(178);
    expect(diffDays).toBeLessThanOrEqual(185);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (reuses buildScanFromDate already implemented)**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/onboarding.test.ts 2>&1 | tail -10
```

Expected: PASS — 2 tests pass.

- [ ] **Step 3: Create `src/components/onboarding/StepPicker.tsx`**

```tsx
// src/components/onboarding/StepPicker.tsx
"use client";

export type LookbackPeriod = "1m" | "3m" | "6m";

type StepPickerProps = {
  value: LookbackPeriod;
  onChange: (p: LookbackPeriod) => void;
  onConfirm: () => void;
  loading: boolean;
};

const options: { value: LookbackPeriod; label: string; desc: string }[] = [
  { value: "1m", label: "Last 1 month", desc: "~30 days of emails" },
  { value: "3m", label: "Last 3 months", desc: "~90 days of emails" },
  { value: "6m", label: "Last 6 months (recommended)", desc: "~180 days — best coverage" },
];

export function StepPicker({ value, onChange, onConfirm, loading }: StepPickerProps) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">How far back should we scan?</h2>
        <p className="text-sm text-gray-500 mt-1">We'll look at email metadata only — no email bodies read yet.</p>
      </div>

      <div className="flex flex-col gap-3">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-4 p-4 rounded-xl border text-left transition-colors ${
              value === opt.value
                ? "border-[#5b7cfa] bg-[#f0f3ff]"
                : "border-gray-200 bg-white hover:border-gray-300"
            }`}
          >
            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
              value === opt.value ? "border-[#5b7cfa]" : "border-gray-300"
            }`}>
              {value === opt.value && <div className="w-2 h-2 rounded-full bg-[#5b7cfa]" />}
            </div>
            <div>
              <div className="text-sm font-medium text-gray-900">{opt.label}</div>
              <div className="text-xs text-gray-500">{opt.desc}</div>
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={onConfirm}
        disabled={loading}
        className="w-full py-3 rounded-xl bg-[#5b7cfa] text-white text-sm font-medium hover:bg-[#4a6be8] transition-colors disabled:opacity-60"
      >
        {loading ? "Scanning..." : "Scan My Gmail"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/components/onboarding/StepScanning.tsx`**

```tsx
// src/components/onboarding/StepScanning.tsx
"use client";

type StepScanningProps = {
  emailCount: number;
};

export function StepScanning({ emailCount }: StepScanningProps) {
  return (
    <div className="flex flex-col items-center gap-6 py-8">
      <div className="w-12 h-12 rounded-full border-4 border-[#e8ecf8] border-t-[#5b7cfa] animate-spin" />
      <div className="text-center">
        <h2 className="text-xl font-semibold text-gray-900">Scanning your Gmail</h2>
        <p className="text-sm text-gray-500 mt-1">Reading email metadata only — no email content accessed yet.</p>
      </div>
      {emailCount > 0 && (
        <div className="bg-[#f0f3ff] px-6 py-3 rounded-xl">
          <span className="text-2xl font-semibold text-[#5b7cfa]">{emailCount.toLocaleString()}</span>
          <span className="text-sm text-gray-600 ml-2">emails scanned</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create `src/components/onboarding/StepReview.tsx`**

```tsx
// src/components/onboarding/StepReview.tsx
"use client";
import { useState } from "react";

export type SenderSummary = {
  sender: string;
  domain: string;
  emailCount: number;
  sampleSubjects: string[];
  sourceRank: number;
  existsInFilter: boolean;
};

export type ScanResult = {
  totalScanned: number;
  financialFound: number;
  autoApproved: SenderSummary[];
  needsReview: SenderSummary[];
};

type StepReviewProps = {
  result: ScanResult;
  onConfirm: (approved: SenderSummary[], rejected: string[]) => void;
  loading: boolean;
};

export function StepReview({ result, onConfirm, loading }: StepReviewProps) {
  const [kept, setKept] = useState<Set<string>>(
    new Set(result.needsReview.map((s) => s.sender))
  );
  const [autoExpanded, setAutoExpanded] = useState(false);

  const toggle = (sender: string) => {
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(sender)) next.delete(sender);
      else next.add(sender);
      return next;
    });
  };

  const handleStart = () => {
    const approved = result.needsReview.filter((s) => kept.has(s.sender));
    const rejected = result.needsReview.filter((s) => !kept.has(s.sender)).map((s) => s.sender);
    onConfirm(approved, rejected);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Summary */}
      <div className="bg-[#f0f3ff] rounded-xl p-4">
        <p className="text-sm text-gray-700">
          We scanned{" "}
          <span className="font-semibold text-gray-900">{result.totalScanned.toLocaleString()} emails</span>
          {" "}and found{" "}
          <span className="font-semibold text-[#5b7cfa]">{result.financialFound} likely financial emails</span>
          {" "}from {result.autoApproved.length + result.needsReview.length} senders.
        </p>
      </div>

      {/* Auto-approved */}
      {result.autoApproved.length > 0 && (
        <div>
          <button
            onClick={() => setAutoExpanded((v) => !v)}
            className="flex items-center justify-between w-full text-left"
          >
            <span className="text-sm font-semibold text-gray-700">
              Auto-approved — {result.autoApproved.length} senders
            </span>
            <span className="text-xs text-[#5b7cfa]">{autoExpanded ? "collapse" : "expand"}</span>
          </button>
          {autoExpanded && (
            <div className="mt-2 flex flex-col gap-2">
              {result.autoApproved.map((s) => (
                <div key={s.sender} className="flex items-center justify-between px-3 py-2 bg-[#f8fdf8] rounded-lg border border-[#c8e6c9]">
                  <div>
                    <span className="text-sm text-gray-800">{s.sender}</span>
                    <span className="text-xs text-gray-500 ml-2">· {s.emailCount} emails</span>
                  </div>
                  <span className="text-xs text-green-600 font-medium">Approved</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Needs review */}
      {result.needsReview.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-gray-700 mb-2">
            Needs your review — {result.needsReview.length} senders
          </p>
          <div className="flex flex-col gap-2">
            {result.needsReview.map((s) => {
              const isKept = kept.has(s.sender);
              return (
                <div
                  key={s.sender}
                  className="flex items-start justify-between px-3 py-3 bg-white rounded-xl border border-gray-200"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-sm font-medium text-gray-900 truncate">{s.sender}</span>
                    <span className="text-xs text-gray-500">{s.emailCount} emails</span>
                    {s.sampleSubjects.slice(0, 1).map((subj, i) => (
                      <span key={i} className="text-xs text-gray-400 italic truncate">&ldquo;{subj}&rdquo;</span>
                    ))}
                  </div>
                  <div className="flex gap-2 ml-3 shrink-0 mt-0.5">
                    <button
                      onClick={() => isKept ? undefined : toggle(s.sender)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                        isKept
                          ? "bg-[#e8ecf8] text-[#5b7cfa] border border-[#5b7cfa]"
                          : "bg-white text-gray-500 border border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      Keep
                    </button>
                    <button
                      onClick={() => isKept ? toggle(s.sender) : undefined}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                        !isKept
                          ? "bg-[#fce8e8] text-red-600 border border-red-200"
                          : "bg-white text-gray-500 border border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      Skip
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={loading}
        className="w-full py-3 rounded-xl bg-[#5b7cfa] text-white text-sm font-medium hover:bg-[#4a6be8] transition-colors disabled:opacity-60"
      >
        {loading ? "Saving your choices..." : "Start Importing"}
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Commit components**

```bash
git add src/components/onboarding/ tests/lib/onboarding.test.ts
git commit -m "feat: add onboarding step components (picker, scanning, review)"
```

---

### Task 7: Onboarding page — wire the 3-step flow

**Files:**
- Modify: `src/app/(app)/onboarding/page.tsx`

- [ ] **Step 1: Replace the stub with the full 3-step onboarding page**

```tsx
// src/app/(app)/onboarding/page.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { StepPicker, LookbackPeriod } from "@/components/onboarding/StepPicker";
import { StepScanning } from "@/components/onboarding/StepScanning";
import { StepReview, ScanResult, SenderSummary } from "@/components/onboarding/StepReview";

type Step = "pick" | "scanning" | "review" | "confirming";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pick");
  const [period, setPeriod] = useState<LookbackPeriod>("6m");
  const [emailCount, setEmailCount] = useState(0);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
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
        const err = await res.json() as { error: string };
        throw new Error(err.error ?? "Scan failed");
      }
      const data = await res.json() as ScanResult & { totalScanned: number };
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
      const res = await fetch("/api/gmail/scan/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, approvedSenders: approved, rejectedSenders: rejected }),
      });
      if (!res.ok) throw new Error("Failed to save choices");
      router.push("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStep("review");
    }
  };

  return (
    <div className="min-h-screen bg-[#eef0f6] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 rounded-lg bg-[#e8ecf8] flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5b7cfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold text-gray-900">Set up Financial Manager</h1>
            <p className="text-xs text-gray-500">Step {step === "pick" ? 1 : step === "scanning" ? 2 : 3} of 3</p>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-[#fce8e8] rounded-xl text-sm text-red-700 border border-red-200">
            {error}
          </div>
        )}

        {/* Steps */}
        {step === "pick" && (
          <StepPicker
            value={period}
            onChange={setPeriod}
            onConfirm={handleScan}
            loading={false}
          />
        )}
        {step === "scanning" && <StepScanning emailCount={emailCount} />}
        {(step === "review" || step === "confirming") && scanResult && (
          <StepReview
            result={scanResult}
            onConfirm={handleConfirm}
            loading={step === "confirming"}
          />
        )}
      </div>
    </div>
  );
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
git add src/app/'(app)'/onboarding/page.tsx
git commit -m "feat: wire 3-step onboarding UI (lookback picker → scan → review)"
```

---

### Task 8: Start dev server and verify end-to-end

- [ ] **Step 1: Start dev server**

```bash
node node_modules/next/dist/bin/next dev
```

- [ ] **Step 2: Verify unauthenticated redirect**

Navigate to `http://localhost:3000/onboarding` → should redirect to `/login`.

- [ ] **Step 3: Verify login page loads**

`http://localhost:3000/login` → login card with "Continue with Google" visible.

- [ ] **Step 4: Complete Google sign-in**

Click "Continue with Google", complete OAuth consent. After sign-in, you'll land on `/dashboard` (redirect from root). Navigate to `/onboarding` manually.

- [ ] **Step 5: Verify Step 1 (picker)**

Three period options visible, "6 months" pre-selected, "Scan My Gmail" button clickable.

- [ ] **Step 6: Click "Scan My Gmail" and verify scanning state**

Spinner visible, "Scanning your Gmail" text, email count appears as metadata loads.

- [ ] **Step 7: Verify Step 3 (review screen)**

Auto-approved senders listed (collapsed by default). Needs-review senders shown with [Keep] / [Skip] toggles. "Start Importing" button visible.

- [ ] **Step 8: Click "Start Importing"**

Should navigate to `/dashboard` (sync flow will be built in Plan 3).

- [ ] **Step 9: Commit final state**

```bash
git add -A
git commit -m "feat: Plan 2 complete — Gmail dry-run scanner and onboarding UI"
```

---

## Self-Review

- [x] Spec coverage: §4 (dry-run scan, review screen, approve/reject, syncFromDate) and §8.0 (3-step onboarding) fully implemented
- [x] No placeholders: all code blocks are complete
- [x] Type consistency: `ScanResult`, `SenderSummary`, `LookbackPeriod` used consistently across lib and components
- [x] Zero LLM calls during scan — only Gmail metadata headers fetched
- [x] Auth guard works: middleware redirects unauthenticated users before any API call

---

## What's Next (Plan 3)

After this plan completes:
- Plan 3: Chunked Gmail sync pipeline — `POST /api/gmail/sync/start`, `POST /api/gmail/sync/chunk` (Gemini LLM parsing), SyncJob polling, progress bar on dashboard
