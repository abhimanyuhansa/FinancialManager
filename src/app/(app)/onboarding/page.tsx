"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { StepPicker, LookbackPeriod } from "@/components/onboarding/StepPicker";
import { SyncProgressBar } from "@/components/SyncProgressBar";

type Step = "pick" | "syncing";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pick");
  const [period, setPeriod] = useState<LookbackPeriod>("6m");
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // If user already synced, skip onboarding
  useEffect(() => {
    fetch("/api/gmail/sync/active")
      .then((r) => r.json())
      .then((data) => {
        if (data?.status === "complete") router.replace("/dashboard");
      })
      .catch(() => {});
  }, [router]);

  const handleStart = async () => {
    setStep("syncing");
    setError(null);
    try {
      const res = await fetch("/api/gmail/sync/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      if (!res.ok) {
        const errData = await res.json() as { error: string; jobId?: string; running?: boolean };
        if (errData.running && errData.jobId) {
          setSyncJobId(errData.jobId);
          return;
        }
        throw new Error(errData.error ?? "Failed to start sync");
      }
      const { jobId } = await res.json() as { jobId: string };
      setSyncJobId(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStep("pick");
    }
  };

  const stepNumber = step === "pick" ? 1 : 2;

  return (
    <div className="min-h-screen bg-[#eef0f6] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-lg">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 rounded-lg bg-[#e8ecf8] flex items-center justify-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5b7cfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold text-gray-900">Set up Financial Manager</h1>
            {step !== "syncing" && <p className="text-xs text-gray-500">Step {stepNumber} of 2</p>}
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 bg-[#fce8e8] rounded-xl text-sm text-red-700 border border-red-200">
            {error}
          </div>
        )}

        {step === "pick" && (
          <StepPicker value={period} onChange={setPeriod} onConfirm={handleStart} loading={false} />
        )}
        {step === "syncing" && syncJobId && (
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold text-gray-900">Importing transactions</h2>
            <p className="text-sm text-gray-500">Parsing emails with Gemini. This may take a few minutes.</p>
            <SyncProgressBar
              jobId={syncJobId}
              onComplete={() => router.push("/dashboard")}
            />
          </div>
        )}
      </div>
    </div>
  );
}
