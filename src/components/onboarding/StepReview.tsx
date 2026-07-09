"use client";
import { useState } from "react";

export type SenderSummary = {
  sender: string;
  domain: string;
  emailCount: number;
  sampleSubjects: string[];
  sourceRank: number;
  existsInFilter: boolean;
};

export type ScanResult = {
  totalScanned: number;
  financialFound: number;
  autoApproved: SenderSummary[];
  needsReview: SenderSummary[];
};

type StepReviewProps = {
  result: ScanResult;
  onConfirm: (approved: SenderSummary[], rejected: string[]) => void;
  loading: boolean;
};

export function StepReview({ result, onConfirm, loading }: StepReviewProps) {
  const [kept, setKept] = useState<Set<string>>(
    new Set(result.needsReview.map((s) => s.sender))
  );
  const [autoExpanded, setAutoExpanded] = useState(false);

  const toggle = (sender: string) => {
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(sender)) next.delete(sender);
      else next.add(sender);
      return next;
    });
  };

  const handleStart = () => {
    const approved = result.needsReview.filter((s) => kept.has(s.sender));
    const rejected = result.needsReview.filter((s) => !kept.has(s.sender)).map((s) => s.sender);
    onConfirm(approved, rejected);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-[#f0f3ff] rounded-xl p-4">
        <p className="text-sm text-gray-700">
          We scanned{" "}
          <span className="font-semibold text-gray-900">{result.totalScanned.toLocaleString()} emails</span>
          {" "}and found{" "}
          <span className="font-semibold text-[#5b7cfa]">{result.financialFound} likely financial emails</span>
          {" "}from {result.autoApproved.length + result.needsReview.length} senders.
        </p>
      </div>

      {result.autoApproved.length > 0 && (
        <div>
          <button
            onClick={() => setAutoExpanded((v) => !v)}
            className="flex items-center justify-between w-full text-left"
          >
            <span className="text-sm font-semibold text-gray-700">
              Auto-approved — {result.autoApproved.length} senders
            </span>
            <span className="text-xs text-[#5b7cfa]">{autoExpanded ? "collapse" : "expand"}</span>
          </button>
          {autoExpanded && (
            <div className="mt-2 flex flex-col gap-2">
              {result.autoApproved.map((s) => (
                <div
                  key={s.sender}
                  className="flex items-center justify-between px-3 py-2 bg-[#f8fdf8] rounded-lg border border-[#c8e6c9]"
                >
                  <div>
                    <span className="text-sm text-gray-800">{s.sender}</span>
                    <span className="text-xs text-gray-500 ml-2">· {s.emailCount} emails</span>
                  </div>
                  <span className="text-xs text-green-600 font-medium">Approved</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result.needsReview.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-gray-700 mb-2">
            Needs your review — {result.needsReview.length} senders
          </p>
          <div className="flex flex-col gap-2">
            {result.needsReview.map((s) => {
              const isKept = kept.has(s.sender);
              return (
                <div
                  key={s.sender}
                  className="flex items-start justify-between px-3 py-3 bg-white rounded-xl border border-gray-200"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-sm font-medium text-gray-900 truncate">{s.sender}</span>
                    <span className="text-xs text-gray-500">{s.emailCount} emails</span>
                    {s.sampleSubjects.slice(0, 1).map((subj, i) => (
                      <span key={i} className="text-xs text-gray-400 italic truncate">
                        &ldquo;{subj}&rdquo;
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2 ml-3 shrink-0 mt-0.5">
                    <button
                      onClick={() => { if (!isKept) toggle(s.sender); }}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                        isKept
                          ? "bg-[#e8ecf8] text-[#5b7cfa] border border-[#5b7cfa]"
                          : "bg-white text-gray-500 border border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      Keep
                    </button>
                    <button
                      onClick={() => { if (isKept) toggle(s.sender); }}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                        !isKept
                          ? "bg-[#fce8e8] text-red-600 border border-red-200"
                          : "bg-white text-gray-500 border border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      Skip
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={loading}
        className="w-full py-3 rounded-xl bg-[#5b7cfa] text-white text-sm font-medium hover:bg-[#4a6be8] transition-colors disabled:opacity-60"
      >
        {loading ? "Saving your choices..." : "Start Importing"}
      </button>
    </div>
  );
}
