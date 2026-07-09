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
    router.push("/dashboard");
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
