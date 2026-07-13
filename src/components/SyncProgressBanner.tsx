"use client";
import { useEffect, useState, useCallback } from "react";

type AdvanceResponse =
  | { phase: "idle" }
  | { phase: "scanning"; scanned: number }
  | { phase: "running"; processed: number; total: number; newTransactions: number }
  | { phase: "rate_limited"; source?: string }
  | { phase: "complete"; newTransactions: number };

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

const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 60_000;
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
  const [advancePhase, setAdvancePhase] = useState<AdvanceResponse | null>(null);
  const [dismissed, setDismissedState] = useState(false);

  const tick = useCallback(async () => {
    try {
      // First check if there's an active job
      const statusRes = await fetch("/api/gmail/sync/active");
      if (!statusRes.ok) return;
      const jobData: SyncJob | null = await statusRes.json();
      if (!jobData) { setJob(null); return; }
      if (isDismissed(jobData.id)) { setDismissedState(true); return; }
      setJob(jobData);
      setDismissedState(false);

      // If job is active, drive the advance endpoint
      if (jobData.status === "scanning" || jobData.status === "running") {
        const advRes = await fetch("/api/gmail/sync/advance");
        if (advRes.ok) {
          const adv: AdvanceResponse = await advRes.json();
          setAdvancePhase(adv);
        }
      }
    } catch {
      // ignore network errors
    }
  }, []);

  useEffect(() => {
    tick();
    const isActive = job?.status === "scanning" || job?.status === "running";
    const interval = setInterval(tick, isActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => clearInterval(interval);
  }, [tick, job?.status]);

  // Auto-dismiss complete banner
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

  const pct = job.totalEmails > 0 ? Math.round((job.processedEmails / job.totalEmails) * 100) : 0;
  const handleDismiss = () => { setDismissed(job.id); setDismissedState(true); };

  if (advancePhase?.phase === "rate_limited") {
    const src = advancePhase.source ?? "api";
    const message = src === "lock_contention"
      ? "Processing paused — another sync is already running. Will retry automatically."
      : `Processing paused — daily quota reached (${src}). Resumes automatically at midnight UTC.`;
    return (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <span className="text-sm text-amber-800">{message}</span>
          <button onClick={handleDismiss} className="ml-4 text-amber-500 hover:text-amber-700 text-sm">✕</button>
        </div>
      </div>
    );
  }

  if (job.status === "scanning") {
    const scanned = advancePhase?.phase === "scanning" ? advancePhase.scanned : job.totalEmails;
    return (
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-blue-800 font-medium">
              Scanning your Gmail… {scanned > 0 ? `${scanned.toLocaleString()} emails found so far` : ""}
            </span>
          </div>
          <p className="text-xs text-blue-600 mt-1">This runs in the background — you can navigate freely</p>
        </div>
      </div>
    );
  }

  if (job.status === "running") {
    const processed = advancePhase?.phase === "running" ? advancePhase.processed : job.processedEmails;
    const total = advancePhase?.phase === "running" ? advancePhase.total : job.totalEmails;
    const txns = advancePhase?.phase === "running" ? advancePhase.newTransactions : job.newTransactions;
    const livePct = total > 0 ? Math.round((processed / total) * 100) : pct;
    return (
      <div className="bg-blue-50 border-b border-blue-200 px-4 py-3">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-blue-800 font-medium">
              Importing Gmail transactions… {processed.toLocaleString()} / {total.toLocaleString()}
            </span>
            <span className="text-sm text-blue-600 font-semibold">{livePct}%</span>
          </div>
          <div className="h-1.5 bg-blue-200 rounded-full">
            <div className="h-full bg-blue-600 rounded-full transition-all duration-300" style={{ width: `${livePct}%` }} />
          </div>
          <p className="text-xs text-blue-600 mt-1">
            {txns} new transactions found · updates every 5 seconds
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
            <a href="/settings?tab=statement-passwords" className="underline font-medium">Enter passwords →</a>
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
            Sync complete — {job.newTransactions} new transactions imported
          </span>
          <button onClick={handleDismiss} className="ml-4 text-green-500 hover:text-[#04B488] text-sm">✕</button>
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
            <button onClick={async () => { await fetch("/api/gmail/sync/start", { method: "POST" }); tick(); }}
              className="underline font-medium">Retry</button>
          </span>
          <button onClick={handleDismiss} className="ml-4 text-[#ED5533] hover:text-[#ED5533] text-sm">✕</button>
        </div>
      </div>
    );
  }

  return null;
}
