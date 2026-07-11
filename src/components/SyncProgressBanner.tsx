"use client";
import { useEffect, useState, useCallback } from "react";

type SyncJob = {
  id: string;
  status: "scanning" | "running" | "complete" | "failed" | "cancelled";
  totalEmails: number;
  processedEmails: number;
  newTransactions: number;
  encryptedBlockedCount: number;
  startedAt: string;
  completedAt: string | null;
};

const POLL_INTERVAL_MS = 5_000;
const AUTO_DISMISS_MS = 10_000;

function isDismissed(jobId: string): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(`sync-banner-dismissed-${jobId}`) === "1";
}

function setDismissed(jobId: string) {
  sessionStorage.setItem(`sync-banner-dismissed-${jobId}`, "1");
}

export function SyncProgressBanner() {
  const [job, setJob] = useState<SyncJob | null>(null);
  const [dismissed, setDismissedState] = useState(false);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch("/api/gmail/sync/active");
      if (!res.ok) return;
      const data: SyncJob | null = await res.json();
      if (!data) {
        setJob(null);
        return;
      }
      if (isDismissed(data.id)) {
        setDismissedState(true);
        return;
      }
      setJob(data);
      setDismissedState(false);
    } catch {
      // ignore network errors
    }
  }, []);

  useEffect(() => {
    fetchJob();
    const interval = setInterval(fetchJob, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchJob]);

  // Auto-dismiss complete banner when no blocked PDFs
  useEffect(() => {
    if (job?.status === "complete" && job.encryptedBlockedCount === 0) {
      const timer = setTimeout(() => {
        setDismissed(job.id);
        setDismissedState(true);
      }, AUTO_DISMISS_MS);
      return () => clearTimeout(timer);
    }
  }, [job]);

  if (!job || dismissed) return null;

  const pct = job.totalEmails > 0
    ? Math.round((job.processedEmails / job.totalEmails) * 100)
    : 0;

  const handleDismiss = () => {
    setDismissed(job.id);
    setDismissedState(true);
  };

  if (job.status === "scanning") {
    return (
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-2">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <div className="w-3 h-3 rounded-full border-2 border-blue-300 border-t-blue-600 animate-spin flex-shrink-0" />
          <span className="text-sm text-blue-800 font-medium">Scanning Gmail inbox…</span>
        </div>
      </div>
    );
  }

  if (job.status === "running") {
    return (
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-blue-800 font-medium">
              Importing Gmail transactions… {job.processedEmails} / {job.totalEmails}
            </span>
            <span className="text-sm text-blue-600 font-semibold">{pct}%</span>
          </div>
          <div className="h-1.5 bg-blue-200 rounded-full">
            <div
              className="h-full bg-blue-600 rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-blue-600 mt-1">
            {job.newTransactions} new transactions found · processed in batches every 15 min
          </p>
        </div>
      </div>
    );
  }

  if (job.status === "complete" && job.encryptedBlockedCount > 0) {
    return (
      <div className="bg-orange-50 border-b border-orange-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-orange-800">
            Sync complete — {job.newTransactions} transactions imported, but{" "}
            <strong>{job.encryptedBlockedCount} encrypted statements</strong> couldn&apos;t be read.{" "}
            <a href="/settings?tab=statement-passwords" className="underline font-medium">
              Enter passwords →
            </a>
          </span>
          <button onClick={handleDismiss} className="ml-4 text-orange-500 hover:text-orange-700 text-sm">✕</button>
        </div>
      </div>
    );
  }

  if (job.status === "complete") {
    return (
      <div className="bg-green-50 border-b border-green-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-green-800 font-medium">
            Sync complete — {job.newTransactions} transactions imported
          </span>
          <button onClick={handleDismiss} className="ml-4 text-green-500 hover:text-green-700 text-sm">✕</button>
        </div>
      </div>
    );
  }

  if (job.status === "failed") {
    return (
      <div className="bg-red-50 border-b border-red-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-red-800">
            Sync failed.{" "}
            <button
              onClick={async () => { await fetch("/api/gmail/sync/start", { method: "POST" }); fetchJob(); }}
              className="underline font-medium"
            >
              Retry
            </button>
          </span>
          <button onClick={handleDismiss} className="ml-4 text-red-500 hover:text-red-700 text-sm">✕</button>
        </div>
      </div>
    );
  }

  return null;
}
