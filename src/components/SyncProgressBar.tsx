"use client";
import { useEffect, useRef, useState } from "react";

type JobStatus = {
  status: string;
  totalEmails: number;
  processedEmails: number;
  newTransactions: number;
  skippedEmails: number;
  done: boolean;
};

type SyncProgressBarProps = {
  jobId: string;
  onComplete?: (newTransactions: number) => void;
  onCancel?: () => void;
};

export function SyncProgressBar({ jobId, onComplete, onCancel }: SyncProgressBarProps) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const runningRef = useRef(true);

  useEffect(() => {
    runningRef.current = true;

    async function tick() {
      try {
        const statusRes = await fetch(`/api/gmail/sync/status?jobId=${jobId}`);
        if (!statusRes.ok) { setError("Failed to get status"); return; }
        const data = (await statusRes.json()) as JobStatus;
        setStatus(data);

        if (data.done || data.status === "cancelled") {
          if (data.status === "cancelled") {
            onCancel?.();
          } else {
            onComplete?.(data.newTransactions);
          }
          return;
        }

        if (runningRef.current) {
          setTimeout(tick, 15000);
        }
      } catch {
        if (runningRef.current) setTimeout(tick, 15000);
      }
    }

    tick();
    return () => { runningRef.current = false; };
  }, [jobId, onComplete, onCancel]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await fetch("/api/gmail/sync/cancel", { method: "POST" });
      onCancel?.();
    } catch {
      setCancelling(false);
    }
  };

  if (error) {
    return (
      <div className="px-4 py-3 bg-[#fce8e8] rounded-xl text-sm text-red-700 border border-red-200">
        {error}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <div className="w-4 h-4 rounded-full border-2 border-gray-200 border-t-[#5b7cfa] animate-spin" />
        Starting sync...
      </div>
    );
  }

  const pct = status.totalEmails > 0
    ? Math.round((status.processedEmails / status.totalEmails) * 100)
    : 0;

  const isDone = status.done || status.status === "complete";
  const isCancelled = status.status === "cancelled";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center text-sm">
        <span className="text-gray-700 font-medium">
          {isDone ? "Sync complete" : isCancelled ? "Sync cancelled" : status.status === "scanning" ? "Scanning Gmail inbox…" : "Syncing Gmail in background…"}
        </span>
        <span className="text-gray-500">{pct}%</span>
      </div>

      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${isCancelled ? "bg-gray-400" : "bg-[#5b7cfa]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-4 text-xs text-gray-500">
          <span>{status.processedEmails} / {status.totalEmails} emails</span>
          <span className="text-[#5b7cfa] font-medium">{status.newTransactions} new transactions found</span>
          {status.skippedEmails > 0 && <span>{status.skippedEmails} skipped</span>}
        </div>
        {!isDone && !isCancelled && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="text-xs text-red-500 hover:text-red-700 transition-colors disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel sync"}
          </button>
        )}
      </div>

      {!isDone && !isCancelled && (
        <p className="text-xs text-gray-400">
          Processing runs every 15 minutes in the background. Progress updates here automatically.
        </p>
      )}

      {isDone && (
        <div className="mt-1 px-4 py-3 bg-[#f0f3ff] rounded-xl text-sm text-[#5b7cfa] font-medium text-center">
          ✓ Imported {status.newTransactions} new transactions
        </div>
      )}

      {isCancelled && (
        <div className="mt-1 px-4 py-3 bg-gray-50 rounded-xl text-sm text-gray-500 text-center">
          Sync was cancelled. Click &quot;Sync Gmail&quot; to start again.
        </div>
      )}
    </div>
  );
}
