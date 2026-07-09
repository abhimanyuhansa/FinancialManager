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
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    fetch("/api/analytics/dashboard")
      .then((r) => r.json())
      .then((d) => setData(d as DashboardData))
      .finally(() => setLoading(false));
  }, [refreshKey]);

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
          <SyncProgressBar
            jobId={syncJobId}
            onComplete={() => {
              setSyncJobId(null);
              setSyncing(false);
              setRefreshKey((k) => k + 1);
            }}
          />
        </div>
      )}

      {/* Needs review banner */}
      {data && data.needsReviewCount > 0 && (
        <a
          href="/transactions?filter=review"
          className="block mb-4 px-4 py-3 bg-[#fff8e1] rounded-xl text-sm text-amber-700 border border-amber-200 hover:bg-[#fff3cd] transition-colors"
        >
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
                  <div
                    key={tx.id}
                    className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-lg">{CATEGORY_ICONS[tx.category] ?? "📦"}</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{tx.merchant}</p>
                        <p className="text-xs text-gray-400">
                          {tx.category} · {new Date(tx.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {tx.needsReview && (
                        <span className="text-xs bg-[#fff8e1] text-amber-600 px-2 py-0.5 rounded-full">
                          Review
                        </span>
                      )}
                      <span
                        className={`text-sm font-semibold ${tx.type === "income" ? "text-green-600" : "text-gray-900"}`}
                      >
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
              <p className="text-sm text-gray-400">No transactions yet. Click &quot;Sync Gmail&quot; to import.</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
