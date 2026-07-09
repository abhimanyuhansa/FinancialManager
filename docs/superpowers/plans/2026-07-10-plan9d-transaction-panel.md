# Plan 9d: Debit Display + Transaction Slide-out Panel + Category Mapping

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix debit display (drop minus sign, use red color, keep green/+ for income); add a right-side slide-out panel triggered by clicking a transaction row; add category picker with single/all-merchant scope; expose the Gmail source link; create the category PATCH API.

**Architecture:** New `TransactionPanel.tsx` component, new `PATCH /api/transactions/[id]/category` route, updates to transactions page and transactions API to include `gmailMsgId` and `source`.

**Prerequisite:** Plan 9a complete (MerchantRule in schema).

**Tech Stack:** Next.js 16, React, Prisma 7, Tailwind CSS

---

## File Map

| File | Action |
|------|--------|
| `src/app/api/transactions/route.ts` | Add `gmailMsgId` to GET select |
| `src/app/api/transactions/[id]/category/route.ts` | New — PATCH category with scope |
| `src/components/TransactionPanel.tsx` | New — slide-out detail + category picker |
| `src/app/(app)/transactions/page.tsx` | Add `gmailMsgId` to Transaction type, wire up slide-out panel, fix debit display |
| `src/app/(app)/dashboard/page.tsx` | Fix debit display in Recent Transactions list |
| `tests/api/transactions-category.test.ts` | New — category PATCH tests |

---

## Task 1: Add gmailMsgId to Transactions API

**Files:**
- Modify: `src/app/api/transactions/route.ts`

- [ ] **Step 1: Add gmailMsgId and source to select**

In `src/app/api/transactions/route.ts`, find the `select` block in the `findMany` call. It currently has: `id, merchant, amount, type, category, date, needsReview, reviewed, source, tag`.

Add `gmailMsgId` to the select:

```typescript
select: {
  id: true,
  merchant: true,
  amount: true,
  type: true,
  category: true,
  date: true,
  needsReview: true,
  reviewed: true,
  source: true,
  tag: true,
  gmailMsgId: true,
},
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/transactions/route.ts
git commit -m "feat(api): expose gmailMsgId in transactions GET response"
```

---

## Task 2: Create Category PATCH API

**Files:**
- Create: `src/app/api/transactions/[id]/category/route.ts`
- Create: `tests/api/transactions-category.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/api/transactions-category.test.ts`:

```typescript
// Integration-style: test the handler logic directly (mock prisma)
import { PATCH } from "@/app/api/transactions/[id]/category/route";
import { NextRequest } from "next/server";

// Mock auth
jest.mock("@/lib/auth", () => ({
  auth: jest.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

// Mock prisma
const mockTransaction = {
  id: "tx-1",
  userId: "user-1",
  merchant: "Swiggy",
  category: "food",
};

const mockPrisma = {
  transaction: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  merchantRule: {
    upsert: jest.fn(),
  },
};
jest.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

function makeRequest(id: string, body: object) {
  return new NextRequest(`http://localhost/api/transactions/${id}/category`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("PATCH /api/transactions/[id]/category", () => {
  beforeEach(() => jest.clearAllMocks());

  it("updates single transaction category (scope=single)", async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction);
    mockPrisma.transaction.update.mockResolvedValue({ ...mockTransaction, category: "transport" });

    const req = makeRequest("tx-1", { category: "transport", scope: "single" });
    const res = await PATCH(req, { params: { id: "tx-1" } });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ updatedCount: 1 });
    expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
      where: { id: "tx-1" },
      data: { category: "transport" },
    });
    expect(mockPrisma.merchantRule.upsert).not.toHaveBeenCalled();
  });

  it("updates all merchant transactions and upserts MerchantRule (scope=all_merchant)", async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction);
    mockPrisma.transaction.updateMany.mockResolvedValue({ count: 5 });
    mockPrisma.merchantRule.upsert.mockResolvedValue({});

    const req = makeRequest("tx-1", { category: "food", scope: "all_merchant" });
    const res = await PATCH(req, { params: { id: "tx-1" } });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ updatedCount: 5 });
    expect(mockPrisma.transaction.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", merchant: "swiggy" },
      data: { category: "food" },
    });
    expect(mockPrisma.merchantRule.upsert).toHaveBeenCalledWith({
      where: { userId_merchantName: { userId: "user-1", merchantName: "swiggy" } },
      update: { category: "food" },
      create: { userId: "user-1", merchantName: "swiggy", category: "food" },
    });
  });

  it("returns 404 if transaction not found", async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(null);
    const req = makeRequest("missing", { category: "food", scope: "single" });
    const res = await PATCH(req, { params: { id: "missing" } });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid scope", async () => {
    mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction);
    const req = makeRequest("tx-1", { category: "food", scope: "invalid" });
    const res = await PATCH(req, { params: { id: "tx-1" } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/api/transactions-category.test.ts --no-coverage
```

Expected: FAIL — route file not found.

- [ ] **Step 3: Create the category PATCH route**

Create `src/app/api/transactions/[id]/category/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: { id: string } };

export async function PATCH(req: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { category, scope } = (await req.json()) as {
    category?: string;
    scope?: "single" | "all_merchant";
  };

  if (!category || !scope || !["single", "all_merchant"].includes(scope)) {
    return NextResponse.json({ error: "Invalid request: category and scope required" }, { status: 400 });
  }

  const tx = await prisma.transaction.findUnique({
    where: { id: params.id },
    select: { id: true, userId: true, merchant: true },
  });

  if (!tx || tx.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (scope === "single") {
    await prisma.transaction.update({
      where: { id: params.id },
      data: { category },
    });
    return NextResponse.json({ updatedCount: 1 });
  }

  // scope === "all_merchant"
  const merchantKey = tx.merchant.toLowerCase().trim();

  const { count } = await prisma.transaction.updateMany({
    where: { userId, merchant: merchantKey },
    data: { category },
  });

  await prisma.merchantRule.upsert({
    where: { userId_merchantName: { userId, merchantName: merchantKey } },
    update: { category },
    create: { userId, merchantName: merchantKey, category },
  });

  return NextResponse.json({ updatedCount: count });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/api/transactions-category.test.ts --no-coverage
```

Expected: PASS — 4 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/app/api/transactions/[id]/category/route.ts tests/api/transactions-category.test.ts
git commit -m "feat(api): add PATCH /api/transactions/[id]/category with single/all_merchant scope"
```

---

## Task 3: Create the TransactionPanel Component

**Files:**
- Create: `src/components/TransactionPanel.tsx`

- [ ] **Step 1: Write TransactionPanel**

Create `src/components/TransactionPanel.tsx`:

```typescript
"use client";
import { useState } from "react";

type Transaction = {
  id: string;
  merchant: string;
  amount: number;
  type: string;
  category: string;
  date: string;
  source: string;
  gmailMsgId: string | null;
  needsReview?: boolean;
};

type Props = {
  transaction: Transaction | null;
  onClose: () => void;
  onCategoryUpdated: (txId: string, newCategory: string) => void;
};

const CATEGORIES = [
  { value: "food", label: "Food", icon: "🍔" },
  { value: "cafe", label: "Cafe", icon: "☕" },
  { value: "transport", label: "Transport", icon: "🚗" },
  { value: "shopping", label: "Shopping", icon: "🛍️" },
  { value: "clothing", label: "Clothing", icon: "👕" },
  { value: "bills", label: "Bills", icon: "⚡" },
  { value: "phone", label: "Phone", icon: "📱" },
  { value: "health", label: "Health", icon: "💊" },
  { value: "learning", label: "Learning", icon: "📚" },
  { value: "ott", label: "OTT", icon: "📺" },
  { value: "rent", label: "Rent", icon: "🏠" },
  { value: "personal", label: "Personal", icon: "💆" },
  { value: "investment", label: "Investment", icon: "📈" },
  { value: "work", label: "Work", icon: "💼" },
  { value: "income", label: "Income", icon: "💰" },
  { value: "other", label: "Other", icon: "📦" },
];

function fmtAmount(amount: number, type: string): string {
  const abs = Math.abs(amount);
  const formatted =
    abs >= 100000 ? `₹${(abs / 100000).toFixed(1)}L`
    : abs >= 1000 ? `₹${(abs / 1000).toFixed(1)}K`
    : `₹${abs}`;
  return type === "income" ? `+${formatted}` : formatted;
}

export function TransactionPanel({ transaction: tx, onClose, onCategoryUpdated }: Props) {
  const [pendingCategory, setPendingCategory] = useState<string | null>(null);
  const [scope, setScope] = useState<"single" | "all_merchant">("single");
  const [saving, setSaving] = useState(false);

  if (!tx) return null;

  const handleCategoryClick = (cat: string) => {
    if (cat === tx.category) return;
    setPendingCategory(cat);
    setScope("single");
  };

  const handleConfirm = async () => {
    if (!pendingCategory) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/transactions/${tx.id}/category`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: pendingCategory, scope }),
      });
      if (res.ok) {
        onCategoryUpdated(tx.id, pendingCategory);
        setPendingCategory(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const amountColor = tx.type === "income" ? "text-green-600" : "text-red-500";
  const displayAmount = fmtAmount(tx.amount, tx.type);

  const catIcon = CATEGORIES.find((c) => c.value === tx.category)?.icon ?? "📦";

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white z-50 shadow-2xl flex flex-col overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{catIcon}</span>
            <div>
              <h2 className="font-semibold text-gray-900 text-lg leading-tight">{tx.merchant}</h2>
              <span className="text-xs text-gray-400 uppercase tracking-wide">{tx.category}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl font-light"
          >
            ✕
          </button>
        </div>

        {/* Amount + Date */}
        <div className="px-5 py-4 border-b border-gray-100">
          <p className={`text-3xl font-bold ${amountColor}`}>{displayAmount}</p>
          <p className="text-sm text-gray-500 mt-1">
            {new Date(tx.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            {" · "}
            <span className={`capitalize font-medium ${tx.type === "income" ? "text-green-600" : "text-red-500"}`}>
              {tx.type}
            </span>
          </p>
        </div>

        {/* Category picker */}
        <div className="px-5 py-4 border-b border-gray-100">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Category</p>
          <div className="grid grid-cols-4 gap-2">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                onClick={() => handleCategoryClick(cat.value)}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg text-xs transition-colors ${
                  (pendingCategory ?? tx.category) === cat.value
                    ? "bg-[#e8ecf8] text-[#5b7cfa] font-medium"
                    : "hover:bg-gray-50 text-gray-600"
                }`}
              >
                <span className="text-xl">{cat.icon}</span>
                <span className="truncate w-full text-center">{cat.label}</span>
              </button>
            ))}
          </div>

          {/* Scope selector + confirm — only shown when pending change */}
          {pendingCategory && pendingCategory !== tx.category && (
            <div className="mt-4 p-3 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-700 font-medium mb-2">Apply to:</p>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mb-1">
                <input
                  type="radio"
                  checked={scope === "single"}
                  onChange={() => setScope("single")}
                  className="accent-[#5b7cfa]"
                />
                Just this transaction
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="radio"
                  checked={scope === "all_merchant"}
                  onChange={() => setScope("all_merchant")}
                  className="accent-[#5b7cfa]"
                />
                All <strong className="mx-1">{tx.merchant}</strong> transactions
              </label>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={handleConfirm}
                  disabled={saving}
                  className="flex-1 py-2 bg-[#5b7cfa] text-white text-sm rounded-lg hover:bg-[#4a6af0] disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Confirm"}
                </button>
                <button
                  onClick={() => setPendingCategory(null)}
                  className="px-4 py-2 text-sm text-gray-600 rounded-lg hover:bg-gray-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Source section */}
        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Source</p>
          {tx.gmailMsgId ? (
            <a
              href={`https://mail.google.com/mail/u/0/#all/${tx.gmailMsgId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-[#5b7cfa] hover:underline"
            >
              View source email ↗
            </a>
          ) : tx.source === "seed" ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-500 text-xs rounded-full">
              Demo data
            </span>
          ) : tx.source === "manual" ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-500 text-xs rounded-full">
              Manually added
            </span>
          ) : (
            <span className="text-sm text-gray-400">Gmail import</span>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/TransactionPanel.tsx
git commit -m "feat(ui): add TransactionPanel slide-out with category picker and source link"
```

---

## Task 4: Wire up transactions page — panel + debit display

**Files:**
- Modify: `src/app/(app)/transactions/page.tsx`

- [ ] **Step 1: Read the full current transactions page**

Read `src/app/(app)/transactions/page.tsx` in full to understand existing row rendering.

- [ ] **Step 2: Update the Transaction type**

Add `gmailMsgId` to the `Transaction` type at the top of the file:

```typescript
type Transaction = {
  id: string;
  merchant: string;
  amount: number;
  type: string;
  category: string;
  date: string;
  needsReview: boolean;
  reviewed: boolean;
  source: string;
  tag: string | null;
  gmailMsgId: string | null;  // add this
};
```

- [ ] **Step 3: Add the amount formatting utility**

Add this function near the top of the component (outside of the component function body, after imports):

```typescript
function fmtAmount(amount: number, type: string): string {
  const abs = Math.abs(amount);
  const formatted =
    abs >= 100000 ? `₹${(abs / 100000).toFixed(1)}L`
    : abs >= 1000 ? `₹${(abs / 1000).toFixed(1)}K`
    : `₹${abs}`;
  return type === "income" ? `+${formatted}` : formatted;
}
```

- [ ] **Step 4: Import TransactionPanel and add selected state**

At the top of `TransactionsPage`:
```typescript
import { TransactionPanel } from "@/components/TransactionPanel";
```

Inside the component, add state:
```typescript
const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
```

- [ ] **Step 5: Add "Demo" badge logic**

Seed transactions have `source === "seed"`. Find the transaction row render. Add a `Demo` badge next to the merchant name:

```typescript
{tx.source === "seed" && (
  <span className="ml-2 text-xs px-1.5 py-0.5 bg-gray-100 text-gray-400 rounded">Demo</span>
)}
```

- [ ] **Step 6: Fix debit amount display**

Find wherever `tx.amount` is rendered in the transaction row. Replace the existing amount display with:

```typescript
<span className={tx.type === "income" ? "text-green-600 font-semibold" : "text-red-500 font-semibold"}>
  {fmtAmount(tx.amount, tx.type)}
</span>
```

Remove any existing logic that renders a minus sign for debits.

- [ ] **Step 7: Make rows clickable — open panel**

On each transaction row `<tr>` or container `<div>`, add:
```typescript
onClick={() => setSelectedTx(tx)}
className="... cursor-pointer hover:bg-gray-50"
```

- [ ] **Step 8: Add TransactionPanel at bottom of JSX return**

At the bottom of the returned JSX (before the closing `</div>`):

```typescript
<TransactionPanel
  transaction={selectedTx}
  onClose={() => setSelectedTx(null)}
  onCategoryUpdated={(txId, newCategory) => {
    setTransactions((prev) =>
      prev.map((t) => (t.id === txId ? { ...t, category: newCategory } : t))
    );
    setSelectedTx((prev) => prev && prev.id === txId ? { ...prev, category: newCategory } : prev);
  }}
/>
```

- [ ] **Step 9: Add Escape key listener**

In the component's `useEffect` or a new one:

```typescript
useEffect(() => {
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setSelectedTx(null);
  };
  document.addEventListener("keydown", handleKey);
  return () => document.removeEventListener("keydown", handleKey);
}, []);
```

- [ ] **Step 10: Commit**

```bash
git add "src/app/(app)/transactions/page.tsx"
git commit -m "feat(transactions): add slide-out panel, fix debit display, add Demo badge"
```

---

## Task 5: Fix debit display on dashboard page

**Files:**
- Modify: `src/app/(app)/dashboard/page.tsx`

- [ ] **Step 1: Read the dashboard Recent Transactions section**

Read `src/app/(app)/dashboard/page.tsx` and find where recent transactions are rendered. Look for any amount formatting that produces a minus sign.

- [ ] **Step 2: Add or reuse fmtAmount**

Add the same formatting function (or import it from a shared util if you prefer, but only create a shared util if the dashboard and transactions pages are the only two callers — don't over-abstract):

```typescript
function fmtAmount(amount: number, type: string): string {
  const abs = Math.abs(amount);
  const formatted =
    abs >= 100000 ? `₹${(abs / 100000).toFixed(1)}L`
    : abs >= 1000 ? `₹${(abs / 1000).toFixed(1)}K`
    : `₹${abs}`;
  return type === "income" ? `+${formatted}` : formatted;
}
```

- [ ] **Step 3: Apply to Recent Transactions list**

Replace the existing amount rendering with:

```typescript
<span className={tx.type === "income" ? "text-green-600 font-semibold" : "text-red-500 font-semibold"}>
  {fmtAmount(tx.amount, tx.type)}
</span>
```

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/dashboard/page.tsx"
git commit -m "fix(dashboard): fix debit display — no minus sign, red color"
```

---

## Self-Check

- [x] `gmailMsgId` returned in GET /api/transactions response
- [x] PATCH /api/transactions/[id]/category: `scope=single` updates one row, no MerchantRule change
- [x] PATCH /api/transactions/[id]/category: `scope=all_merchant` updates all merchant rows + upserts MerchantRule with normalized (lowercase) merchant name
- [x] TransactionPanel: right-side slide-out, 400px, translate-x transition
- [x] Category picker: 4×4 grid, current category highlighted
- [x] Scope selector only appears after selecting a different category
- [x] "View source email ↗" link when gmailMsgId present
- [x] "Demo data" badge when source === "seed"
- [x] Debit display: no minus sign, red color; income: +₹ green
- [x] CSV export NOT changed (keeps minus sign for spreadsheet compat)
- [x] Transaction rows clickable to open panel
- [x] Escape key closes panel
- [x] Category update reflected in list without page reload
