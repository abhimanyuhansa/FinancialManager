"use client";
import { useState } from "react";
import { SyncProgressBar } from "@/components/SyncProgressBar";

export default function DashboardPage() {
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/gmail/sync/start", { method: "POST" });
      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        throw new Error(err.error ?? "Failed to start sync");
      }
      const { jobId } = (await res.json()) as { jobId: string };
      setSyncJobId(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSyncing(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Your financial overview</p>
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

      {error && (
        <div className="mb-4 px-4 py-3 bg-[#fce8e8] rounded-xl text-sm text-red-700 border border-red-200">
          {error}
        </div>
      )}

      {syncJobId && (
        <div className="mb-6 bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Syncing Gmail</h2>
          <SyncProgressBar
            jobId={syncJobId}
            onComplete={() => setSyncJobId(null)}
          />
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <p className="text-sm text-gray-500">KPI cards, charts, and recent transactions will appear here in Plan 5.</p>
      </div>
    </div>
  );
}
