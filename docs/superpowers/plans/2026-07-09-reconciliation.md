# Financial Manager — Statement Reconciliation (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the statement reconciliation pipeline — fetch a statement email's full body, extract all line items with Gemini, compare each against existing `Transaction` records for the same user and period, write `ReconciliationLog` rows, and expose the results via a status API so the UI (Settings → Audit tab, Plan 8) can display matched / missing / mismatched entries.

**Architecture:** A single `POST /api/gmail/reconcile` route accepts a `gmailMsgId` pointing to a statement email. It fetches the full email body, calls Gemini with the reconciliation prompt (spec §10), normalises the extracted line items, then runs a 3-way comparison against `Transaction` rows. All results are written to `ReconciliationLog`. A `GET /api/gmail/reconcile` route returns all reconciliation logs for the user. The Gemini statement parsing logic lives in `src/lib/reconcile.ts` (a pure function, separately testable); the API route is a thin orchestrator.

**Tech Stack:** Next.js App Router API routes, Gmail REST API v1 (full message format), Gemini 2.5 Flash (`gemini-flash-latest`), Prisma 7, NextAuth v5

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/lib/reconcile.ts` | Parse Gemini statement response, normalise line items, compare against transactions, return match results |
| Create | `src/app/api/gmail/reconcile/route.ts` | POST — fetch statement email, call reconcile lib, write ReconciliationLog rows; GET — return all logs |
| Create | `tests/lib/reconcile.test.ts` | Unit tests for statement line item parsing and comparison logic |

---

### Task 1: Reconciliation library — `src/lib/reconcile.ts` (TDD)

**Files:**
- Create: `src/lib/reconcile.ts`
- Create: `tests/lib/reconcile.test.ts`

Three pure functions:

1. `parseStatementItems(geminiResponseText)` — takes the raw Gemini JSON string, parses and validates it, returns `StatementItem[]`. Handles markdown fences, invalid JSON, missing fields.
2. `normaliseStatementItem(item)` — coerces raw parsed fields to typed `StatementItem`. Maps `"debit"` → `"expense"`, `"credit"` → `"income"`. Discards items with `amount <= 0`.
3. `matchStatementItem(item, transactions)` — given one statement line item and a list of candidate transactions (already filtered by userId), returns a `MatchResult`: `"matched"` (exact merchant+amount+date within 2-day window), `"mismatch"` (amount or merchant differs within date window), or `"missing"` (no candidate in date window at all). Uses the same 2-day bucket logic as `buildFingerprint`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/reconcile.test.ts
import {
  parseStatementItems,
  normaliseStatementItem,
  matchStatementItem,
  StatementItem,
  CandidateTransaction,
} from "@/lib/reconcile";

describe("parseStatementItems", () => {
  it("parses a valid Gemini JSON array", () => {
    const raw = JSON.stringify([
      { date: "2026-06-15", merchant: "Swiggy", amount: 349, type: "expense" },
      { date: "2026-06-16", merchant: "Salary", amount: 50000, type: "income" },
    ]);
    const items = parseStatementItems(raw);
    expect(items).toHaveLength(2);
    expect(items[0].merchant).toBe("Swiggy");
    expect(items[1].amount).toBe(50000);
  });

  it("strips markdown code fences before parsing", () => {
    const raw = "```json\n[{\"date\":\"2026-06-15\",\"merchant\":\"Zomato\",\"amount\":250,\"type\":\"expense\"}]\n```";
    const items = parseStatementItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].merchant).toBe("Zomato");
  });

  it("returns empty array on invalid JSON", () => {
    const items = parseStatementItems("not json at all");
    expect(items).toHaveLength(0);
  });

  it("returns empty array on empty string", () => {
    expect(parseStatementItems("")).toHaveLength(0);
  });
});

describe("normaliseStatementItem", () => {
  it("maps debit to expense", () => {
    const item = normaliseStatementItem({
      date: "2026-06-15",
      merchant: "Swiggy",
      amount: 349,
      type: "debit",
    });
    expect(item).not.toBeNull();
    expect(item!.type).toBe("expense");
  });

  it("maps credit to income", () => {
    const item = normaliseStatementItem({
      date: "2026-06-15",
      merchant: "HDFC",
      amount: 50000,
      type: "credit",
    });
    expect(item).not.toBeNull();
    expect(item!.type).toBe("income");
  });

  it("returns null when amount <= 0", () => {
    const item = normaliseStatementItem({
      date: "2026-06-15",
      merchant: "Swiggy",
      amount: 0,
      type: "expense",
    });
    expect(item).toBeNull();
  });

  it("returns null when date is missing", () => {
    const item = normaliseStatementItem({
      date: null,
      merchant: "Swiggy",
      amount: 349,
      type: "expense",
    });
    expect(item).toBeNull();
  });
});

describe("matchStatementItem", () => {
  const makeItem = (merchant: string, amount: number, date: string): StatementItem => ({
    date,
    merchant,
    amount,
    type: "expense",
  });

  const makeTx = (merchant: string, amount: number, date: string): CandidateTransaction => ({
    id: "tx1",
    merchant,
    amount,
    date: new Date(date),
    type: "expense",
  });

  it("returns matched when merchant + amount + date bucket align", () => {
    const item = makeItem("Swiggy", 349, "2026-06-15");
    const tx = makeTx("Swiggy", 349, "2026-06-15T10:00:00Z");
    expect(matchStatementItem(item, [tx])).toBe("matched");
  });

  it("returns mismatch when amount differs within date window", () => {
    const item = makeItem("Swiggy", 349, "2026-06-15");
    const tx = makeTx("Swiggy", 300, "2026-06-15T10:00:00Z");
    expect(matchStatementItem(item, [tx])).toBe("mismatch");
  });

  it("returns missing when no transaction in date window", () => {
    const item = makeItem("Swiggy", 349, "2026-06-15");
    const tx = makeTx("Swiggy", 349, "2026-07-01T10:00:00Z");
    expect(matchStatementItem(item, [tx])).toBe("missing");
  });

  it("returns missing when candidate list is empty", () => {
    const item = makeItem("Swiggy", 349, "2026-06-15");
    expect(matchStatementItem(item, [])).toBe("missing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/reconcile.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/lib/reconcile'`

- [ ] **Step 3: Create `src/lib/reconcile.ts`**

```typescript
// src/lib/reconcile.ts

export type StatementItem = {
  date: string;      // ISO date string
  merchant: string;
  amount: number;    // always positive
  type: "expense" | "income";
};

export type CandidateTransaction = {
  id: string;
  merchant: string;
  amount: number;
  date: Date;
  type: string;
};

export type MatchStatus = "matched" | "mismatch" | "missing";

export function parseStatementItems(raw: string): StatementItem[] {
  if (!raw) return [];
  try {
    const clean = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return [];
    return parsed as StatementItem[];
  } catch {
    return [];
  }
}

type RawItem = {
  date?: string | null;
  merchant?: string | null;
  amount?: number | null;
  type?: string | null;
};

export function normaliseStatementItem(raw: RawItem): StatementItem | null {
  if (!raw.date) return null;
  if (typeof raw.amount !== "number" || raw.amount <= 0) return null;

  const merchant = raw.merchant ?? "Unknown";
  let type: "expense" | "income" = "expense";
  if (raw.type === "income" || raw.type === "credit") type = "income";
  else if (raw.type === "expense" || raw.type === "debit") type = "expense";

  return { date: raw.date, merchant, amount: raw.amount, type };
}

const TWO_DAY_MS = 2 * 24 * 60 * 60 * 1000;

function dateBucket(d: Date): number {
  return Math.floor(d.getTime() / TWO_DAY_MS);
}

export function matchStatementItem(
  item: StatementItem,
  candidates: CandidateTransaction[]
): MatchStatus {
  const itemBucket = dateBucket(new Date(item.date));

  const inWindow = candidates.filter(
    (tx) => dateBucket(tx.date) === itemBucket
  );

  if (inWindow.length === 0) return "missing";

  const exact = inWindow.find(
    (tx) =>
      tx.amount === item.amount &&
      tx.merchant.toLowerCase().replace(/[^a-z0-9]/g, "") ===
        item.merchant.toLowerCase().replace(/[^a-z0-9]/g, "")
  );
  if (exact) return "matched";

  return "mismatch";
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/reconcile.test.ts 2>&1 | tail -10
```

Expected: PASS — 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reconcile.ts tests/lib/reconcile.test.ts
git commit -m "feat: add reconcile library — parseStatementItems, normaliseStatementItem, matchStatementItem with tests"
```

---

### Task 2: Reconcile API routes (`POST` and `GET /api/gmail/reconcile`)

**Files:**
- Create: `src/app/api/gmail/reconcile/route.ts`

**POST** — takes `{ gmailMsgId }`, fetches the full email body using the Gmail API (reuses `fetchFullMessage`-style logic inline), calls Gemini with the reconciliation prompt, parses and normalises line items, queries `Transaction` rows for the user within the statement's date range (±30 days of the earliest/latest line item date), runs `matchStatementItem` for each line item, writes `ReconciliationLog` rows, returns a summary.

**GET** — returns all `ReconciliationLog` rows for the authenticated user, ordered by `createdAt` descending.

- [ ] **Step 1: Create `src/app/api/gmail/reconcile/route.ts`**

```typescript
// src/app/api/gmail/reconcile/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { parseStatementItems, normaliseStatementItem, matchStatementItem, CandidateTransaction } from "@/lib/reconcile";

const STATEMENT_SYSTEM_PROMPT =
  "This is a bank or credit card statement. Extract every transaction listed. " +
  "Return a JSON array where each item has: " +
  '{"date": string, "merchant": string, "amount": number, "type": "expense"|"debit"|"credit"|"income"}. ' +
  "Return only the array. No explanations.";

async function fetchStatementBody(
  accessToken: string,
  msgId: string
): Promise<{ body: string; receivedDate: string } | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;

  const msg = await res.json() as {
    internalDate?: string;
    payload?: {
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    };
  };

  const receivedDate = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  const parts = msg.payload?.parts ?? [];
  const plainPart = parts.find((p) => p.mimeType === "text/plain");
  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  const rawData =
    plainPart?.body?.data ?? htmlPart?.body?.data ?? msg.payload?.body?.data ?? "";

  if (!rawData) return { body: "", receivedDate };

  const decoded = Buffer.from(rawData, "base64url").toString("utf-8");
  const body = decoded
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);

  return { body, receivedDate };
}

async function callGeminiForStatement(body: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: STATEMENT_SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [{ text: `Statement:\n${body}` }],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) return "[]";
  const data = await res.json() as {
    candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { gmailMsgId } = (await req.json()) as { gmailMsgId?: string };
  if (!gmailMsgId) {
    return NextResponse.json({ error: "Missing gmailMsgId" }, { status: 400 });
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const statement = await fetchStatementBody(accessToken, gmailMsgId);
  if (!statement || !statement.body) {
    return NextResponse.json({ error: "Could not fetch statement email" }, { status: 422 });
  }

  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const geminiRaw = await callGeminiForStatement(statement.body, apiKey);

  const rawItems = parseStatementItems(geminiRaw);
  const items = rawItems
    .map((raw) => normaliseStatementItem(raw))
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) {
    return NextResponse.json({ error: "No line items extracted from statement" }, { status: 422 });
  }

  // Determine date range of statement items (±30 days) for candidate query
  const dates = items.map((item) => new Date(item.date).getTime()).filter((d) => !isNaN(d));
  const minDate = new Date(Math.min(...dates) - 30 * 24 * 60 * 60 * 1000);
  const maxDate = new Date(Math.max(...dates) + 30 * 24 * 60 * 60 * 1000);

  const dbTransactions = await prisma.transaction.findMany({
    where: {
      userId,
      date: { gte: minDate, lte: maxDate },
    },
    select: { id: true, merchant: true, amount: true, date: true, type: true },
  });

  const candidates: CandidateTransaction[] = dbTransactions.map((tx) => ({
    id: tx.id,
    merchant: tx.merchant,
    amount: tx.amount,
    date: tx.date,
    type: tx.type,
  }));

  // Write ReconciliationLog rows
  let matched = 0;
  let missing = 0;
  let mismatch = 0;

  for (const item of items) {
    const status = matchStatementItem(item, candidates);
    if (status === "matched") matched++;
    else if (status === "missing") missing++;
    else mismatch++;

    const matchedTx = status === "matched"
      ? candidates.find((tx) => {
          const itemBucket = Math.floor(new Date(item.date).getTime() / (2 * 24 * 60 * 60 * 1000));
          const txBucket = Math.floor(tx.date.getTime() / (2 * 24 * 60 * 60 * 1000));
          return (
            txBucket === itemBucket &&
            tx.amount === item.amount &&
            tx.merchant.toLowerCase().replace(/[^a-z0-9]/g, "") ===
              item.merchant.toLowerCase().replace(/[^a-z0-9]/g, "")
          );
        })
      : null;

    const mismatchDetails =
      status === "mismatch"
        ? (() => {
            const inWindow = candidates.filter((tx) => {
              const ib = Math.floor(new Date(item.date).getTime() / (2 * 24 * 60 * 60 * 1000));
              const tb = Math.floor(tx.date.getTime() / (2 * 24 * 60 * 60 * 1000));
              return ib === tb;
            });
            const first = inWindow[0];
            if (!first) return null;
            const parts: string[] = [];
            if (first.amount !== item.amount)
              parts.push(`amount differs: statement=${item.amount}, captured=${first.amount}`);
            if (
              first.merchant.toLowerCase().replace(/[^a-z0-9]/g, "") !==
              item.merchant.toLowerCase().replace(/[^a-z0-9]/g, "")
            )
              parts.push(`merchant differs: statement="${item.merchant}", captured="${first.merchant}"`);
            return parts.join("; ") || null;
          })()
        : null;

    await prisma.reconciliationLog.create({
      data: {
        userId,
        statementGmailMsgId: gmailMsgId,
        statementDate: new Date(item.date),
        statementMerchant: item.merchant,
        statementAmount: item.amount,
        matchedTransactionId: matchedTx?.id ?? null,
        status,
        mismatchDetails,
      },
    });
  }

  return NextResponse.json({
    totalItems: items.length,
    matched,
    missing,
    mismatch,
  });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const logs = await prisma.reconciliationLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      statementGmailMsgId: true,
      statementDate: true,
      statementMerchant: true,
      statementAmount: true,
      matchedTransactionId: true,
      status: true,
      mismatchDetails: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ logs });
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

Expected: all tests pass (35 + 11 = 46 total).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/gmail/reconcile/route.ts
git commit -m "feat: add POST + GET /api/gmail/reconcile — statement parsing and ReconciliationLog"
```

---

### Task 3: Dev server smoke test

- [ ] **Step 1: Start dev server**

```bash
node node_modules/next/dist/bin/next dev --port 3000 > /tmp/next-dev.log 2>&1 &
sleep 6
```

- [ ] **Step 2: Verify all three reconcile endpoints return auth guard**

```bash
# POST without auth → 307 (middleware redirect) or 401
echo "POST reconcile:"; curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/gmail/reconcile \
  -H "Content-Type: application/json" -d '{"gmailMsgId":"fake"}'
echo ""

# GET without auth → 307
echo "GET reconcile:"; curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/gmail/reconcile
echo ""
```

Expected: 307 (auth middleware intercepts before handler).

- [ ] **Step 3: Stop dev server**

```bash
pkill -f "next dev" 2>/dev/null || true
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: Plan 4 complete — statement reconciliation pipeline"
```

---

## Self-Review

**1. Spec coverage:**

- [x] §5 reconciliation flow: `POST /api/gmail/reconcile` → fetches full statement body → Gemini extracts line items → compared against `Transaction` rows → `ReconciliationLog` rows written — fully implemented
- [x] §10 reconciliation prompt: system prompt matches spec exactly (`"expense"|"debit"|"credit"|"income"`)
- [x] `ReconciliationLog` schema fields all used: `statementGmailMsgId`, `statementDate`, `statementMerchant`, `statementAmount`, `matchedTransactionId`, `status`, `mismatchDetails`
- [x] Three status values: `"matched"`, `"mismatch"`, `"missing"` — all produced correctly
- [x] `GET /api/gmail/reconcile` returns logs for Settings → Audit tab (Plan 8)
- [x] Auth guard on both POST and GET

**2. Placeholder scan:** No TODOs, TBDs, or incomplete steps. All code blocks are complete.

**3. Type consistency:**
- `StatementItem`, `CandidateTransaction`, `MatchStatus` all defined in `reconcile.ts` and exported — imported correctly in route
- `normaliseStatementItem` accepts `RawItem` (loose types from JSON parse) and returns `StatementItem | null` — matches test expectations
- `parseStatementItems` returns `StatementItem[]` directly from JSON — normalisation happens separately in the route — consistent with test setup
