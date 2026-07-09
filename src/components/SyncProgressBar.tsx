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
};

export function SyncProgressBar({ jobId, onComplete }: SyncProgressBarProps) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(true);

  useEffect(() => {
    runningRef.current = true;

    async function tick() {
      try {
        const chunkRes = await fetch("/api/gmail/sync/chunk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });
        if (!chunkRes.ok) {
          const err = (await chunkRes.json()) as { error: string };
          setError(err.error ?? "Sync failed");
          return;
        }

        const statusRes = await fetch(`/api/gmail/sync/status?jobId=${jobId}`);
        if (!statusRes.ok) { setError("Failed to get status"); return; }
        const data = (await statusRes.json()) as JobStatus;
        setStatus(data);

        if (data.done) {
          onComplete?.(data.newTransactions);
          return;
        }

        if (runningRef.current) {
          setTimeout(tick, 2000);
        }
      } catch {
        setError("Network error during sync");
      }
    }

    tick();
    return () => { runningRef.current = false; };
  }, [jobId, onComplete]);

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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between text-sm">
        <span className="text-gray-700 font-medium">
          {status.done ? "Sync complete" : "Syncing Gmail..."}
        </span>
        <span className="text-gray-500">{pct}%</span>
      </div>

      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-[#5b7cfa] rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex gap-4 text-xs text-gray-500">
        <span>{status.processedEmails} / {status.totalEmails} emails</span>
        <span className="text-[#5b7cfa] font-medium">{status.newTransactions} new transactions</span>
        {status.skippedEmails > 0 && <span>{status.skippedEmails} skipped</span>}
      </div>

      {status.done && (
        <div className="mt-1 px-4 py-3 bg-[#f0f3ff] rounded-xl text-sm text-[#5b7cfa] font-medium text-center">
          Imported {status.newTransactions} transactions — go to Dashboard to see them
        </div>
      )}
    </div>
  );
}
