# Financial Manager — Dashboard KPIs + Charts (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full Dashboard page — KPI row (Net Worth, Income, Spent) with MoM delta badges, a monthly income-vs-expenses grouped bar chart (6-month view), a category spending donut chart, and a recent-transactions feed — all driven by a single analytics API endpoint that computes aggregates server-side.

**Architecture:** `GET /api/analytics/dashboard` returns all data the dashboard needs in one round-trip: KPI values for the current month, the previous month (for delta computation), six months of monthly income/expense totals, category breakdown for the current month, and the five most recent transactions. The dashboard page is a Client Component that fetches this endpoint on mount and renders the four sections. All chart components use Recharts (already installed). Badge logic matches the spec (§11): green = net worth up / income up / expense down, red = opposite. The analytics computation logic lives in `src/lib/analytics.ts` (pure functions, TDD-testable without Prisma).

**Tech Stack:** Next.js App Router, Recharts, Prisma 7, NextAuth v5, Tailwind CSS

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/lib/analytics.ts` | Pure functions: `computeKpis`, `computeMonthlyTotals`, `computeCategoryBreakdown`, `getBadgeVariant` |
| Create | `src/app/api/analytics/dashboard/route.ts` | GET — run analytics queries, return dashboard payload |
| Modify | `src/app/(app)/dashboard/page.tsx` | Replace stub with full dashboard UI |
| Create | `src/components/KpiCard.tsx` | KPI card with delta badge |
| Create | `src/components/BarChartCard.tsx` | Monthly income vs expenses grouped bar chart |
| Create | `src/components/DonutChartCard.tsx` | Category spending donut chart |
| Create | `tests/lib/analytics.test.ts` | Unit tests for KPI and badge logic |

---

### Task 1: Analytics library — `src/lib/analytics.ts` (TDD)

**Files:**
- Create: `src/lib/analytics.ts`
- Create: `tests/lib/analytics.test.ts`

Four pure functions:

1. `getBadgeVariant(metric, direction)` — spec §11 exactly. Returns `"good" | "bad" | "neutral"`.
2. `computeKpis(transactions, assetTotal)` — given an array of transactions for a period and total asset value, returns `{ income, expenses, netWorth }`.
3. `computeMonthlyTotals(transactions)` — groups transactions by `YYYY-MM` key, returns `MonthlyTotal[]` sorted ascending.
4. `computeCategoryBreakdown(transactions)` — sums expense amounts by category, returns `CategoryTotal[]` sorted descending by amount.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/analytics.test.ts
import {
  getBadgeVariant,
  computeKpis,
  computeMonthlyTotals,
  computeCategoryBreakdown,
} from "@/lib/analytics";

describe("getBadgeVariant", () => {
  it("networth up → good", () => expect(getBadgeVariant("networth", "up")).toBe("good"));
  it("networth down → bad", () => expect(getBadgeVariant("networth", "down")).toBe("bad"));
  it("income up → good", () => expect(getBadgeVariant("income", "up")).toBe("good"));
  it("income down → bad", () => expect(getBadgeVariant("income", "down")).toBe("bad"));
  it("expense up → bad", () => expect(getBadgeVariant("expense", "up")).toBe("bad"));
  it("expense down → good", () => expect(getBadgeVariant("expense", "down")).toBe("good"));
  it("unchanged → neutral", () => expect(getBadgeVariant("income", "unchanged")).toBe("neutral"));
});

describe("computeKpis", () => {
  const transactions = [
    { amount: 50000, type: "income" as const, category: "income", date: new Date("2026-06-15") },
    { amount: 349, type: "expense" as const, category: "food", date: new Date("2026-06-16") },
    { amount: 1200, type: "expense" as const, category: "transport", date: new Date("2026-06-17") },
  ];

  it("sums income correctly", () => {
    const kpis = computeKpis(transactions, 100000);
    expect(kpis.income).toBe(50000);
  });

  it("sums expenses correctly", () => {
    const kpis = computeKpis(transactions, 100000);
    expect(kpis.expenses).toBe(1549);
  });

  it("netWorth = assetTotal + income - expenses", () => {
    const kpis = computeKpis(transactions, 100000);
    expect(kpis.netWorth).toBe(100000 + 50000 - 1549);
  });
});

describe("computeMonthlyTotals", () => {
  const transactions = [
    { amount: 300, type: "expense" as const, date: new Date("2026-05-10") },
    { amount: 500, type: "expense" as const, date: new Date("2026-05-20") },
    { amount: 1000, type: "income" as const, date: new Date("2026-05-15") },
    { amount: 400, type: "expense" as const, date: new Date("2026-06-05") },
    { amount: 2000, type: "income" as const, date: new Date("2026-06-10") },
  ];

  it("groups by month key", () => {
    const totals = computeMonthlyTotals(transactions);
    expect(totals).toHaveLength(2);
    expect(totals[0].month).toBe("2026-05");
    expect(totals[1].month).toBe("2026-06");
  });

  it("sums income and expenses per month", () => {
    const totals = computeMonthlyTotals(transactions);
    expect(totals[0].income).toBe(1000);
    expect(totals[0].expenses).toBe(800);
    expect(totals[1].income).toBe(2000);
    expect(totals[1].expenses).toBe(400);
  });
});

describe("computeCategoryBreakdown", () => {
  const transactions = [
    { amount: 349, type: "expense" as const, category: "food" },
    { amount: 200, type: "expense" as const, category: "food" },
    { amount: 500, type: "expense" as const, category: "transport" },
    { amount: 50000, type: "income" as const, category: "income" },
  ];

  it("sums amounts by category (expenses only)", () => {
    const breakdown = computeCategoryBreakdown(transactions);
    const food = breakdown.find((c) => c.category === "food");
    expect(food?.amount).toBe(549);
  });

  it("excludes income transactions", () => {
    const breakdown = computeCategoryBreakdown(transactions);
    const income = breakdown.find((c) => c.category === "income");
    expect(income).toBeUndefined();
  });

  it("sorts by amount descending", () => {
    const breakdown = computeCategoryBreakdown(transactions);
    expect(breakdown[0].category).toBe("transport");
    expect(breakdown[1].category).toBe("food");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/analytics.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/lib/analytics'`

- [ ] **Step 3: Create `src/lib/analytics.ts`**

```typescript
// src/lib/analytics.ts

export type BadgeVariant = "good" | "bad" | "neutral";
export type BadgeMetric = "networth" | "income" | "expense" | "savings" | "yoy_spend";
export type Direction = "up" | "down" | "unchanged";

export function getBadgeVariant(metric: BadgeMetric, direction: Direction): BadgeVariant {
  if (direction === "unchanged") return "neutral";
  const goodWhenUp: BadgeMetric[] = ["networth", "income", "savings"];
  const goodWhenDown: BadgeMetric[] = ["expense", "yoy_spend"];
  if (goodWhenUp.includes(metric)) return direction === "up" ? "good" : "bad";
  if (goodWhenDown.includes(metric)) return direction === "down" ? "good" : "bad";
  return "neutral";
}

type TxForKpi = { amount: number; type: "income" | "expense" };

export type KpiResult = { income: number; expenses: number; netWorth: number };

export function computeKpis(transactions: TxForKpi[], assetTotal: number): KpiResult {
  let income = 0;
  let expenses = 0;
  for (const tx of transactions) {
    if (tx.type === "income") income += tx.amount;
    else expenses += tx.amount;
  }
  return { income, expenses, netWorth: assetTotal + income - expenses };
}

type TxForMonthly = { amount: number; type: "income" | "expense"; date: Date };

export type MonthlyTotal = { month: string; income: number; expenses: number };

export function computeMonthlyTotals(transactions: TxForMonthly[]): MonthlyTotal[] {
  const map = new Map<string, MonthlyTotal>();
  for (const tx of transactions) {
    const month = tx.date.toISOString().slice(0, 7); // "YYYY-MM"
    if (!map.has(month)) map.set(month, { month, income: 0, expenses: 0 });
    const entry = map.get(month)!;
    if (tx.type === "income") entry.income += tx.amount;
    else entry.expenses += tx.amount;
  }
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
}

type TxForCategory = { amount: number; type: "income" | "expense"; category: string };

export type CategoryTotal = { category: string; amount: number };

export function computeCategoryBreakdown(transactions: TxForCategory[]): CategoryTotal[] {
  const map = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.type !== "expense") continue;
    map.set(tx.category, (map.get(tx.category) ?? 0) + tx.amount);
  }
  return Array.from(map.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && npx jest tests/lib/analytics.test.ts 2>&1 | tail -10
```

Expected: PASS — 14 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/analytics.ts tests/lib/analytics.test.ts
git commit -m "feat: add analytics library — computeKpis, computeMonthlyTotals, computeCategoryBreakdown, getBadgeVariant with tests"
```

---

### Task 2: Analytics API — `GET /api/analytics/dashboard`

**Files:**
- Create: `src/app/api/analytics/dashboard/route.ts`

Returns a single JSON payload:

```typescript
{
  currentMonth: { income: number; expenses: number; netWorth: number };
  prevMonth:    { income: number; expenses: number; netWorth: number };
  monthlyTotals: MonthlyTotal[];          // last 6 months
  categoryBreakdown: CategoryTotal[];     // current month expenses by category
  recentTransactions: RecentTx[];         // last 5 transactions
  needsReviewCount: number;
}
```

- [ ] **Step 1: Create `src/app/api/analytics/dashboard/route.ts`**

```typescript
// src/app/api/analytics/dashboard/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeKpis, computeMonthlyTotals, computeCategoryBreakdown } from "@/lib/analytics";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const now = new Date();
  // Start of current month
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // Start of previous month
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  // 6 months ago
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  // Fetch transactions for the last 6 months
  const sixMonthTxs = await prisma.transaction.findMany({
    where: { userId, date: { gte: sixMonthsAgo } },
    select: { amount: true, type: true, category: true, date: true },
    orderBy: { date: "desc" },
  });

  const currentMonthTxs = sixMonthTxs.filter((tx) => tx.date >= currentMonthStart);
  const prevMonthTxs = sixMonthTxs.filter(
    (tx) => tx.date >= prevMonthStart && tx.date < currentMonthStart
  );

  // Total asset value for net worth
  const assets = await prisma.asset.findMany({
    where: { userId },
    select: { value: true },
  });
  const assetTotal = assets.reduce((sum, a) => sum + a.value, 0);

  const currentMonth = computeKpis(
    currentMonthTxs.map((tx) => ({ amount: tx.amount, type: tx.type as "income" | "expense" })),
    assetTotal
  );
  const prevMonth = computeKpis(
    prevMonthTxs.map((tx) => ({ amount: tx.amount, type: tx.type as "income" | "expense" })),
    assetTotal
  );

  const monthlyTotals = computeMonthlyTotals(
    sixMonthTxs.map((tx) => ({
      amount: tx.amount,
      type: tx.type as "income" | "expense",
      date: tx.date,
    }))
  );

  const categoryBreakdown = computeCategoryBreakdown(
    currentMonthTxs.map((tx) => ({
      amount: tx.amount,
      type: tx.type as "income" | "expense",
      category: tx.category,
    }))
  );

  const recentTransactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { date: "desc" },
    take: 5,
    select: {
      id: true,
      merchant: true,
      amount: true,
      type: true,
      category: true,
      date: true,
      needsReview: true,
    },
  });

  const needsReviewCount = await prisma.transaction.count({
    where: { userId, needsReview: true, reviewed: false },
  });

  return NextResponse.json({
    currentMonth,
    prevMonth,
    monthlyTotals,
    categoryBreakdown,
    recentTransactions,
    needsReviewCount,
  });
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/analytics/dashboard/route.ts
git commit -m "feat: add GET /api/analytics/dashboard — KPIs, monthly totals, category breakdown, recent transactions"
```

---

### Task 3: `KpiCard` component

**Files:**
- Create: `src/components/KpiCard.tsx`

Props: `{ label: string; value: number; prevValue: number; metric: BadgeMetric; prefix?: string }`

Shows the label, formatted value, and a delta badge. The badge shows the % change vs previous period with the correct color from `getBadgeVariant`.

- [ ] **Step 1: Create `src/components/KpiCard.tsx`**

```tsx
// src/components/KpiCard.tsx
import { getBadgeVariant, BadgeMetric } from "@/lib/analytics";

type KpiCardProps = {
  label: string;
  value: number;
  prevValue: number;
  metric: BadgeMetric;
  prefix?: string;
};

function formatAmount(n: number, prefix = "₹"): string {
  if (n >= 100000) return `${prefix}${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${prefix}${(n / 1000).toFixed(1)}K`;
  return `${prefix}${n.toLocaleString("en-IN")}`;
}

export function KpiCard({ label, value, prevValue, metric, prefix = "₹" }: KpiCardProps) {
  const direction =
    value > prevValue ? "up" : value < prevValue ? "down" : "unchanged";
  const variant = getBadgeVariant(metric, direction);

  const pct =
    prevValue !== 0
      ? Math.abs(Math.round(((value - prevValue) / prevValue) * 100))
      : null;

  const badgeColors = {
    good: "bg-[#e8f5e9] text-green-700",
    bad: "bg-[#fce8e8] text-red-700",
    neutral: "bg-gray-100 text-gray-500",
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col gap-2">
      <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-semibold text-gray-900">{formatAmount(value, prefix)}</span>
      {pct !== null && (
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full w-fit ${badgeColors[variant]}`}
        >
          {direction === "up" ? "↑" : "↓"} {pct}% vs last month
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/KpiCard.tsx
git commit -m "feat: add KpiCard component with delta badge"
```

---

### Task 4: `BarChartCard` and `DonutChartCard` components

**Files:**
- Create: `src/components/BarChartCard.tsx`
- Create: `src/components/DonutChartCard.tsx`

Both are `"use client"` (Recharts requires client rendering).

`BarChartCard` — renders a grouped bar chart (income vs expenses per month). Uses Recharts `BarChart`, `Bar`, `XAxis`, `YAxis`, `Tooltip`, `Legend`, `ResponsiveContainer`. Props: `{ data: MonthlyTotal[] }`.

`DonutChartCard` — renders a donut chart of expense categories. Uses Recharts `PieChart`, `Pie`, `Cell`, `Tooltip`, `Legend`, `ResponsiveContainer`. Props: `{ data: CategoryTotal[] }`. Colors map to the spec's category pastel palette.

- [ ] **Step 1: Create `src/components/BarChartCard.tsx`**

```tsx
// src/components/BarChartCard.tsx
"use client";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type { MonthlyTotal } from "@/lib/analytics";

type BarChartCardProps = {
  data: MonthlyTotal[];
};

function shortMonth(month: string): string {
  const [year, m] = month.split("-");
  const date = new Date(Number(year), Number(m) - 1, 1);
  return date.toLocaleString("en", { month: "short" });
}

function formatK(value: number): string {
  if (value >= 100000) return `${(value / 100000).toFixed(1)}L`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
  return String(value);
}

export function BarChartCard({ data }: BarChartCardProps) {
  const chartData = data.map((d) => ({
    month: shortMonth(d.month),
    Income: Math.round(d.income),
    Expenses: Math.round(d.expenses),
  }));

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Income vs Expenses (6 months)</h2>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} barCategoryGap="30%" barGap={4}>
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={formatK} tick={{ fontSize: 12, fill: "#9ca3af" }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            formatter={(value: number) => [`₹${value.toLocaleString("en-IN")}`, undefined]}
            contentStyle={{ borderRadius: 12, border: "1px solid #f0f0f0", fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Income" fill="#5b7cfa" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Expenses" fill="#f87171" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/DonutChartCard.tsx`**

```tsx
// src/components/DonutChartCard.tsx
"use client";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { CategoryTotal } from "@/lib/analytics";

const CATEGORY_COLORS: Record<string, string> = {
  food: "#fb923c",
  cafe: "#fb923c",
  transport: "#34d399",
  metro: "#34d399",
  shopping: "#fbbf24",
  clothing: "#fbbf24",
  bills: "#a78bfa",
  phone: "#a78bfa",
  health: "#60a5fa",
  learning: "#60a5fa",
  ott: "#4ade80",
  rent: "#f87171",
  personal: "#f472b6",
  investment: "#6ee7b7",
  work: "#93c5fd",
  other: "#d1c4a8",
};

function categoryColor(category: string): string {
  return CATEGORY_COLORS[category.toLowerCase()] ?? "#d1d5db";
}

type DonutChartCardProps = {
  data: CategoryTotal[];
};

export function DonutChartCard({ data }: DonutChartCardProps) {
  if (data.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex items-center justify-center h-[280px]">
        <p className="text-sm text-gray-400">No expense data this month</p>
      </div>
    );
  }

  const chartData = data.slice(0, 8).map((d) => ({
    name: d.category.charAt(0).toUpperCase() + d.category.slice(1),
    value: Math.round(d.amount),
    category: d.category,
  }));

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Spending by Category</h2>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={3}
            dataKey="value"
          >
            {chartData.map((entry) => (
              <Cell key={entry.category} fill={categoryColor(entry.category)} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number) => [`₹${value.toLocaleString("en-IN")}`, undefined]}
            contentStyle={{ borderRadius: 12, border: "1px solid #f0f0f0", fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: Run TypeScript check**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager && node node_modules/typescript/lib/tsc.js --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/BarChartCard.tsx src/components/DonutChartCard.tsx
git commit -m "feat: add BarChartCard and DonutChartCard components"
```

---

### Task 5: Wire everything into the Dashboard page

**Files:**
- Modify: `src/app/(app)/dashboard/page.tsx`

Replace the stub with the full dashboard. The page fetches `/api/analytics/dashboard` on mount, shows a loading skeleton while waiting, then renders: KPI row → bar chart → donut chart → recent transactions feed. The existing Sync Gmail button is preserved in the header.

- [ ] **Step 1: Replace `src/app/(app)/dashboard/page.tsx`**

```tsx
// src/app/(app)/dashboard/page.tsx
"use client";
import { useEffect, useState } from "react";
import { SyncProgressBar } from "@/components/SyncProgressBar";
import { KpiCard } from "@/components/KpiCard";
import { BarChartCard } from "@/components/BarChartCard";
import { DonutChartCard } from "@/components/DonutChartCard";
import type { MonthlyTotal, CategoryTotal } from "@/lib/analytics";

type KpiData = { income: number; expenses: number; netWorth: number };
type RecentTx = {
  id: string;
  merchant: string;
  amount: number;
  type: string;
  category: string;
  date: string;
  needsReview: boolean;
};
type DashboardData = {
  currentMonth: KpiData;
  prevMonth: KpiData;
  monthlyTotals: MonthlyTotal[];
  categoryBreakdown: CategoryTotal[];
  recentTransactions: RecentTx[];
  needsReviewCount: number;
};

const CATEGORY_ICONS: Record<string, string> = {
  food: "🍔", cafe: "☕", transport: "🚗", metro: "🚇",
  shopping: "🛍️", clothing: "👕", bills: "⚡", phone: "📱",
  health: "💊", learning: "📚", ott: "📺", rent: "🏠",
  personal: "💆", investment: "📈", work: "💼", income: "💰", other: "📦",
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/analytics/dashboard")
      .then((r) => r.json())
      .then((d) => setData(d as DashboardData))
      .finally(() => setLoading(false));
  }, [syncJobId]); // re-fetch after sync completes

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/gmail/sync/start", { method: "POST" });
      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        throw new Error(err.error ?? "Failed to start sync");
      }
      const { jobId } = (await res.json()) as { jobId: string };
      setSyncJobId(jobId);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Something went wrong");
      setSyncing(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleString("en", { month: "long", year: "numeric" })}
          </p>
        </div>
        {!syncJobId && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#5b7cfa] text-white text-sm font-medium hover:bg-[#4a6be8] transition-colors disabled:opacity-60"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Sync Gmail
          </button>
        )}
      </div>

      {syncError && (
        <div className="mb-4 px-4 py-3 bg-[#fce8e8] rounded-xl text-sm text-red-700 border border-red-200">
          {syncError}
        </div>
      )}

      {syncJobId && (
        <div className="mb-6 bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Syncing Gmail</h2>
          <SyncProgressBar jobId={syncJobId} onComplete={() => { setSyncJobId(null); setSyncing(false); }} />
        </div>
      )}

      {/* Needs review banner */}
      {data && data.needsReviewCount > 0 && (
        <a href="/transactions?filter=review" className="block mb-4 px-4 py-3 bg-[#fff8e1] rounded-xl text-sm text-amber-700 border border-amber-200 hover:bg-[#fff3cd] transition-colors">
          ⚠️ {data.needsReviewCount} transaction{data.needsReviewCount > 1 ? "s" : ""} need your review →
        </a>
      )}

      {loading ? (
        <div className="flex flex-col gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 bg-gray-100 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : data ? (
        <div className="flex flex-col gap-6">
          {/* KPI row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <KpiCard
              label="Net Worth"
              value={data.currentMonth.netWorth}
              prevValue={data.prevMonth.netWorth}
              metric="networth"
            />
            <KpiCard
              label="Income"
              value={data.currentMonth.income}
              prevValue={data.prevMonth.income}
              metric="income"
            />
            <KpiCard
              label="Spent"
              value={data.currentMonth.expenses}
              prevValue={data.prevMonth.expenses}
              metric="expense"
            />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <BarChartCard data={data.monthlyTotals} />
            <DonutChartCard data={data.categoryBreakdown} />
          </div>

          {/* Recent transactions */}
          {data.recentTransactions.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-700">Recent Transactions</h2>
                <a href="/transactions" className="text-xs text-[#5b7cfa] hover:underline">View all</a>
              </div>
              <div className="flex flex-col gap-1">
                {data.recentTransactions.map((tx) => (
                  <div key={tx.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-3">
                      <span className="text-lg">{CATEGORY_ICONS[tx.category] ?? "📦"}</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{tx.merchant}</p>
                        <p className="text-xs text-gray-400">{tx.category} · {new Date(tx.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {tx.needsReview && (
                        <span className="text-xs bg-[#fff8e1] text-amber-600 px-2 py-0.5 rounded-full">Review</span>
                      )}
                      <span className={`text-sm font-semibold ${tx.type === "income" ? "text-green-600" : "text-gray-900"}`}>
                        {tx.type === "income" ? "+" : "−"}₹{tx.amount.toLocaleString("en-IN")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.recentTransactions.length === 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
              <p className="text-sm text-gray-400">No transactions yet. Click "Sync Gmail" to import.</p>
            </div>
          )}
        </div>
      ) : null}
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

Expected: all tests pass (47 + 14 = 61 total).

- [ ] **Step 4: Commit**

```bash
git add src/app/'(app)'/dashboard/page.tsx
git commit -m "feat: wire full dashboard — KPI cards, bar chart, donut chart, recent transactions feed"
```

---

### Task 6: Dev server visual verification

- [ ] **Step 1: Start dev server**

```bash
node node_modules/next/dist/bin/next dev --port 3000 > /tmp/next-dev.log 2>&1 &
sleep 6
```

- [ ] **Step 2: Check for compile errors**

```bash
grep -i "error\|failed" /tmp/next-dev.log | grep -v "^$" | head -20
```

Expected: no errors.

- [ ] **Step 3: Verify auth guard on analytics endpoint**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/analytics/dashboard
echo ""
```

Expected: 307 (middleware redirect).

- [ ] **Step 4: Open browser and verify dashboard renders**

Navigate to `http://localhost:3000/dashboard` (will redirect to login).

After signing in (or navigating directly if session cookie exists), verify:
- Dashboard heading + month label
- KPI row with 3 cards (Net Worth, Income, Spent)
- Bar chart placeholder renders (empty is fine, no JS errors)
- Donut chart renders or shows "No expense data" placeholder
- Recent transactions or empty state message visible

- [ ] **Step 5: Stop server and final commit**

```bash
pkill -f "next dev" 2>/dev/null || true
git add -A
git commit -m "feat: Plan 5 complete — Dashboard KPIs, charts, recent transactions"
```

---

## Self-Review

**1. Spec coverage:**

- [x] §8.1 Dashboard KPI row (Net Worth · Income · Spent) — 3 KpiCards with correct metrics
- [x] §11 Badge logic — `getBadgeVariant` matches spec exactly: networth/income/savings good when up, expense/yoy_spend good when down
- [x] §8.1 Grouped bar chart (income vs expenses, 6-month view) — BarChartCard
- [x] §8.1 Category donut chart — DonutChartCard with spec's 16 category colors
- [x] §8.1 Recent transactions feed (last 5) — merchant · category · date · amount
- [x] §8.1 Review queue banner (`needsReviewCount > 0`) — amber banner with link to /transactions?filter=review
- [x] §8.1 "Sync Gmail" button — preserved, triggers SyncProgressBar, re-fetches dashboard on complete

**2. Placeholder scan:** No TODOs, TBDs, or incomplete steps. All code blocks complete.

**3. Type consistency:**
- `MonthlyTotal`, `CategoryTotal`, `BadgeMetric`, `KpiResult` all defined in `analytics.ts`, exported, imported correctly in API route and components
- `DashboardData` type in dashboard page matches the exact shape returned by the API route — consistent
- `BarChartCard` accepts `MonthlyTotal[]`, `DonutChartCard` accepts `CategoryTotal[]` — both imported from `@/lib/analytics` — consistent
