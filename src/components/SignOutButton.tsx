"use client";

import { useRef, useState } from "react";
import { signOut } from "next-auth/react";

type SignOutAction = (options: { redirectTo: string }) => Promise<unknown>;

export async function runSignOutOnce(
  inProgress: { current: boolean },
  action: SignOutAction,
): Promise<boolean> {
  if (inProgress.current) return false;

  inProgress.current = true;
  try {
    await action({ redirectTo: "/login" });
    return true;
  } catch (error) {
    inProgress.current = false;
    throw error;
  }
}

type SignOutButtonProps = {
  placement: "sidebar" | "settings";
};

export function SignOutButton({ placement }: SignOutButtonProps) {
  const inProgress = useRef(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState("");

  const handleSignOut = async () => {
    if (inProgress.current) return;

    setIsSigningOut(true);
    setError("");
    try {
      await runSignOutOnce(inProgress, signOut);
    } catch {
      setError("Sign out failed. Please try again.");
      setIsSigningOut(false);
    }
  };

  const isSidebar = placement === "sidebar";

  return (
    <div className={isSidebar ? "mt-auto pt-3" : ""}>
      <button
        type="button"
        onClick={() => void handleSignOut()}
        disabled={isSigningOut}
        aria-label="Sign out"
        className={
          isSidebar
            ? "w-full flex items-center gap-3 rounded-lg px-3 py-3 text-[#7C7E8C] hover:bg-red-50 hover:text-[#ED5533] disabled:cursor-not-allowed disabled:opacity-60"
            : "inline-flex items-center justify-center rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm font-medium text-[#ED5533] hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        {isSidebar && (
          <svg
            className="h-5 w-5 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        )}
        <span className={isSidebar ? "hidden lg:block text-sm font-medium" : ""}>
          {isSigningOut ? "Signing out…" : "Sign out"}
        </span>
      </button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
