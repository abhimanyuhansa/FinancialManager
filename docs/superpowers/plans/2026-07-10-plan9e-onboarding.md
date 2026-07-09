# Plan 9e: Onboarding Splash Overlay + Seed Data Exclusion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a splash overlay on first login (no real transactions), exclude seed data from analytics when real data exists, add a "Clear Demo Data" button in Settings, and add a DELETE /api/transactions/demo endpoint.

**Architecture:** Dashboard page checks for seed-only state and renders an overlay component. Analytics API excludes `source="seed"` transactions when the user has at least one non-seed transaction. Settings page adds a "Clear Demo Data" button.

**Prerequisite:** Plan 9a complete (seed `source` changed to `"seed"`).

**Tech Stack:** Next.js 16, React, Prisma 7, sessionStorage

---

## File Map

| File | Action |
|------|--------|
| `src/app/api/transactions/demo/route.ts` | New — DELETE all seed transactions |
| `src/app/api/analytics/dashboard/route.ts` | Exclude `source="seed"` from KPIs when real data exists |
| `src/components/OnboardingOverlay.tsx` | New — splash overlay component |
| `src/app/(app)/dashboard/page.tsx` | Import + render OnboardingOverlay, check for seed-only state |
| `src/app/(app)/settings/page.tsx` | Add "Clear Demo Data" button |

---

## Task 1: Create the Demo Data DELETE endpoint

**Files:**
- Create: `src/app/api/transactions/demo/route.ts`

- [ ] **Step 1: Write the demo delete route**

Create `src/app/api/transactions/demo/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { count } = await prisma.transaction.deleteMany({
    where: { userId: session.user.id, source: "seed" },
  });

  return NextResponse.json({ deleted: count });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/transactions/demo/route.ts
git commit -m "feat(api): add DELETE /api/transactions/demo to clear seed data"
```

---

## Task 2: Exclude seed data from analytics

**Files:**
- Modify: `src/app/api/analytics/dashboard/route.ts`

- [ ] **Step 1: Read the full analytics dashboard route**

Read `src/app/api/analytics/dashboard/route.ts` in full before making changes.

- [ ] **Step 2: Add seed exclusion logic**

After the `auth()` check and before the main queries, add a check for whether the user has any real (non-seed) transactions:

```typescript
// Check if user has any real transactions
const realTxCount = await prisma.transaction.count({
  where: { userId, source: { not: "seed" } },
});
const hasRealData = realTxCount > 0;
```

Then in the main `sixMonthTxs` query, add a source filter when `hasRealData` is true:

```typescript
const sixMonthTxs = await prisma.transaction.findMany({
  where: {
    userId,
    date: { gte: sixMonthsAgo },
    ...(hasRealData ? { source: { not: "seed" } } : {}),
  },
  select: { amount: true, type: true, category: true, date: true },
  orderBy: { date: "desc" },
});
```

Also update the `recentTransactions` query in the same route to apply the same filter.

- [ ] **Step 3: Add `hasRealData` to response**

In the return `NextResponse.json(...)` call, include:

```typescript
return NextResponse.json({
  currentMonth: ...,
  prevMonth: ...,
  monthlyTotals: ...,
  categoryBreakdown: ...,
  recentTransactions: ...,
  needsReviewCount: ...,
  hasRealData,  // add this
});
```

- [ ] **Step 4: Update dashboard DashboardData type**

In `src/app/(app)/dashboard/page.tsx`, add `hasRealData: boolean` to the `DashboardData` type:

```typescript
type DashboardData = {
  currentMonth: KpiData;
  prevMonth: KpiData;
  monthlyTotals: MonthlyTotal[];
  categoryBreakdown: CategoryTotal[];
  recentTransactions: RecentTx[];
  needsReviewCount: number;
  hasRealData: boolean;  // add this
};
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/analytics/dashboard/route.ts "src/app/(app)/dashboard/page.tsx"
git commit -m "feat(analytics): exclude seed transactions from KPIs when real data exists"
```

---

## Task 3: Create the Onboarding Splash Overlay

**Files:**
- Create: `src/components/OnboardingOverlay.tsx`

- [ ] **Step 1: Write the overlay component**

Create `src/components/OnboardingOverlay.tsx`:

```typescript
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  hasRealData: boolean;
};

const SESSION_KEY = "onboarding-overlay-dismissed";

export function OnboardingOverlay({ hasRealData }: Props) {
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (hasRealData) return;
    if (typeof window !== "undefined" && sessionStorage.getItem(SESSION_KEY)) return;
    setVisible(true);
  }, [hasRealData]);

  if (!visible) return null;

  const handleDismiss = () => {
    sessionStorage.setItem(SESSION_KEY, "1");
    setVisible(false);
  };

  const handleStartSync = () => {
    sessionStorage.setItem(SESSION_KEY, "1");
    setVisible(false);
    router.push("/onboarding");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-black/30">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 p-8">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <div className="w-14 h-14 rounded-xl bg-[#e8ecf8] flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b7cfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
        </div>

        <h2 className="text-2xl font-bold text-gray-900 text-center mb-3">
          Welcome to Financial Manager
        </h2>
        <p className="text-gray-500 text-center text-sm leading-relaxed mb-8">
          Automatically import your transactions from Gmail — bank alerts, payment receipts, and merchant emails are parsed and categorised for you. Connect your Gmail account to get started.
        </p>

        <div className="flex flex-col gap-3">
          <button
            onClick={handleStartSync}
            className="w-full py-3 bg-[#5b7cfa] text-white font-semibold rounded-xl hover:bg-[#4a6af0] transition-colors"
          >
            Start Gmail Sync
          </button>
          <button
            onClick={handleDismiss}
            className="w-full py-3 text-gray-500 text-sm hover:text-gray-700 transition-colors"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add overlay to dashboard page**

In `src/app/(app)/dashboard/page.tsx`:

1. Import at the top:
```typescript
import { OnboardingOverlay } from "@/components/OnboardingOverlay";
```

2. The dashboard already fetches `data` from `/api/analytics/dashboard`. After the data is loaded (not null), render the overlay:

```typescript
return (
  <>
    {data && <OnboardingOverlay hasRealData={data.hasRealData} />}
    {/* ... rest of the dashboard JSX ... */}
  </>
);
```

The overlay renders on top of the dashboard content (via `z-50 fixed inset-0`), so the dashboard renders fully behind it.

- [ ] **Step 3: Commit**

```bash
git add src/components/OnboardingOverlay.tsx "src/app/(app)/dashboard/page.tsx"
git commit -m "feat(onboarding): add splash overlay for fresh users with no real transactions"
```

---

## Task 4: Add Clear Demo Data button to Settings

**Files:**
- Modify: `src/app/(app)/settings/page.tsx`

- [ ] **Step 1: Read the settings page**

Read `src/app/(app)/settings/page.tsx` to understand the current layout and where to add the button.

- [ ] **Step 2: Add Clear Demo Data button**

Find the appropriate place in Settings (e.g., a "Data" or "Account" section). Add:

```typescript
const [clearingDemo, setClearingDemo] = useState(false);
const [demoCleared, setDemoCleared] = useState(false);

const handleClearDemo = async () => {
  if (!confirm("This will permanently delete all demo transactions. Continue?")) return;
  setClearingDemo(true);
  try {
    const res = await fetch("/api/transactions/demo", { method: "DELETE" });
    const data = await res.json() as { deleted: number };
    setDemoCleared(true);
    alert(`Deleted ${data.deleted} demo transaction${data.deleted !== 1 ? "s" : ""}.`);
  } finally {
    setClearingDemo(false);
  }
};
```

And in the JSX:

```typescript
<div className="mt-6">
  <h3 className="text-sm font-semibold text-gray-700 mb-2">Demo Data</h3>
  <p className="text-sm text-gray-500 mb-3">
    Remove the sample transactions that were pre-loaded to demonstrate the app.
  </p>
  <button
    onClick={handleClearDemo}
    disabled={clearingDemo || demoCleared}
    className="px-4 py-2 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
  >
    {demoCleared ? "Demo data cleared" : clearingDemo ? "Clearing…" : "Clear Demo Data"}
  </button>
</div>
```

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/page.tsx"
git commit -m "feat(settings): add Clear Demo Data button"
```

---

## Self-Check

- [x] DELETE /api/transactions/demo removes only `source="seed"` transactions for the current user
- [x] Analytics KPIs exclude seed transactions when `realTxCount > 0`
- [x] `hasRealData` returned in analytics dashboard response
- [x] Onboarding overlay: full-screen backdrop-blur, centered white card
- [x] Overlay shown when `hasRealData === false`, dismissed into sessionStorage (not localStorage — reappears on next session)
- [x] Overlay not shown on `/onboarding` page itself (it only renders on dashboard)
- [x] "Start Gmail Sync" navigates to `/onboarding`
- [x] "Skip for now" dismisses without navigating
- [x] "Clear Demo Data" button in Settings calls DELETE endpoint with confirmation dialog
