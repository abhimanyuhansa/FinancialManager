"use client";
import { useEffect, useState } from "react";
import { SyncProgressBar } from "@/components/SyncProgressBar";
import { KpiCard } from "@/components/KpiCard";
import { BarChartCard } from "@/components/BarChartCard";
import { DonutChartCard } from "@/components/DonutChartCard";
import { OnboardingOverlay } from "@/components/OnboardingOverlay";
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
  hasRealData: boolean;
};

const CATEGORY_ICONS: Record<string, string> = {
  food: "🍔", cafe: "☕", transport: "🚗", metro: "🚇",
  shopping: "🛍️", clothing: "👕", bills: "⚡", phone: "📱",
  health: "💊", learning: "📚", ott: "📺", rent: "🏠",
  personal: "💆", investment: "📈", work: "💼", income: "💰", other: "📦",
};

function fmtAmount(amount: number, type: string): string {
  const abs = Math.abs(amount);
  const formatted =
    abs >= 100000 ? `₹${(abs / 100000).toFixed(1)}L`
    : abs >= 1000 ? `₹${(abs / 1000).toFixed(1)}K`
    : `₹${abs}`;
  return type === "income" ? `+${formatted}` : formatted;
}

type ActiveJob = { id: string; status: string; totalEmails: number; processedEmails: number; newTransactions: number };

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncChecked, setSyncChecked] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // On load, check if a sync is already running and auto-attach to it
  useEffect(() => {
    fetch("/api/gmail/sync/active")
      .then((r) => r.ok ? r.json() : null)
      .then((job: ActiveJob | null) => {
        if (job && (job.status === "running" || job.status === "scanning")) {
          setSyncJobId(job.id);
          setSyncing(true);
        }
      })
      .catch(() => {})
      .finally(() => setSyncChecked(true));
  }, []);

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
      const body = await res.json() as { jobId?: string; error?: string; running?: boolean };
      if (!res.ok) {
        if (res.status === 409 && body.jobId) {
          // Already running — attach to existing job
          setSyncJobId(body.jobId);
          return;
        }
        throw new Error(body.error ?? "Failed to start sync");
      }
      setSyncJobId(body.jobId!);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Something went wrong");
      setSyncing(false);
    }
  };

  const handleSyncComplete = (newTx: number) => {
    setSyncJobId(null);
    setSyncing(false);
    if (newTx > 0) setRefreshKey((k) => k + 1);
  };

  const handleSyncCancel = () => {
    setSyncJobId(null);
    setSyncing(false);
  };

  return (
    <>
      {data && <OnboardingOverlay hasRealData={data.hasRealData} onStartSync={handleSync} />}
      <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#44475B]">Dashboard</h1>
          <p className="text-sm text-[#7C7E8C] mt-0.5">
            {new Date().toLocaleString("en", { month: "long", year: "numeric" })}
          </p>
        </div>
        {syncChecked && !syncJobId && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#04B488] text-white text-sm font-medium hover:bg-[#03a07a] transition-colors disabled:opacity-60"
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
        <div className="mb-4 px-4 py-3 bg-[#fce8e8] rounded-lg text-sm text-[#ED5533] border border-red-200">
          {syncError}
        </div>
      )}

      {syncJobId && (
        <div className="mb-6 bg-white rounded-lg border border-[#E9E9EB]  p-6">
          <h2 className="text-base font-semibold text-[#44475B] mb-4">Syncing Gmail</h2>
          <SyncProgressBar
            jobId={syncJobId}
            onComplete={handleSyncComplete}
            onCancel={handleSyncCancel}
          />
        </div>
      )}

      {/* Needs review banner */}
      {data && data.needsReviewCount > 0 && (
        <a
          href="/transactions?filter=review"
          className="block mb-4 px-4 py-3 bg-[#fff8e1] rounded-lg text-sm text-amber-700 border border-amber-200 hover:bg-[#fff3cd] transition-colors"
        >
          ⚠️ {data.needsReviewCount} transaction{data.needsReviewCount > 1 ? "s" : ""} need your review →
        </a>
      )}

      {loading ? (
        <div className="flex flex-col gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 bg-[#F8F8F8] rounded-lg animate-pulse" />
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
            <div className="bg-white rounded-lg border border-[#E9E9EB]  p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-[#44475B]">Recent Transactions</h2>
                <a href="/transactions" className="text-xs text-[#04B488] hover:underline">View all</a>
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
                        <p className="text-sm font-medium text-[#44475B]">{tx.merchant}</p>
                        <p className="text-xs text-[#A1A3AD]">
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
                        className={`text-sm font-semibold ${tx.type === "income" ? "text-[#04B488]" : "text-[#ED5533]"}`}
                      >
                        {fmtAmount(tx.amount, tx.type)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.recentTransactions.length === 0 && (
            <div className="bg-white rounded-lg border border-[#E9E9EB]  p-8 text-center">
              <p className="text-sm text-[#A1A3AD]">No transactions yet. Click &quot;Sync Gmail&quot; to import.</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
    </>
  );
}
