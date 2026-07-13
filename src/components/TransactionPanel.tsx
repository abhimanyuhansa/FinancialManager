"use client";
import { useState } from "react";

type Transaction = {
  id: string;
  merchant: string;
  amount: number;
  type: string;
  category: string;
  subCategory: string | null;
  date: string;
  source: string;
  tag: string | null;
  gmailMsgId: string | null;
  needsReview?: boolean;
};

type Props = {
  transaction: Transaction | null;
  onClose: () => void;
  onCategoryUpdated: (txId: string, newCategory: string) => void;
  onVpaLabeled?: () => void;
};

const CATEGORIES = [
  { value: "food", label: "Food", icon: "🍔" },
  { value: "cafe", label: "Cafe", icon: "☕" },
  { value: "transport", label: "Transport", icon: "🚗" },
  { value: "shopping", label: "Shopping", icon: "🛍️" },
  { value: "clothing", label: "Clothing", icon: "👕" },
  { value: "bills", label: "Bills", icon: "⚡" },
  { value: "phone", label: "Phone", icon: "📱" },
  { value: "health", label: "Health", icon: "💊" },
  { value: "learning", label: "Learning", icon: "📚" },
  { value: "ott", label: "OTT", icon: "📺" },
  { value: "rent", label: "Rent", icon: "🏠" },
  { value: "personal", label: "Personal", icon: "💆" },
  { value: "investment", label: "Investment", icon: "📈" },
  { value: "work", label: "Work", icon: "💼" },
  { value: "income", label: "Income", icon: "💰" },
  { value: "other", label: "Other", icon: "📦" },
];

function fmtAmount(amount: number, type: string): string {
  const abs = Math.abs(amount);
  const formatted =
    abs >= 100000 ? `₹${(abs / 100000).toFixed(1)}L`
    : abs >= 1000 ? `₹${(abs / 1000).toFixed(1)}K`
    : `₹${abs}`;
  return type === "income" ? `+${formatted}` : formatted;
}

export function TransactionPanel({ transaction: tx, onClose, onCategoryUpdated, onVpaLabeled }: Props) {
  const [pendingCategory, setPendingCategory] = useState<string | null>(null);
  const [scope, setScope] = useState<"single" | "all_merchant">("single");
  const [saving, setSaving] = useState(false);

  // VPA identification state
  const vpa = tx?.tag?.startsWith("vpa:") ? tx.tag.replace("vpa:", "") : null;
  const isUnknown = tx?.merchant === "Unknown" && !!vpa;
  const hasVpa = !!vpa;
  const [identifyName, setIdentifyName] = useState(tx?.merchant === "Unknown" ? "" : (tx?.merchant ?? ""));
  const [identifyCategory, setIdentifyCategory] = useState(tx?.category ?? "other");
  const [applyToAll, setApplyToAll] = useState(true);
  const [identifySaving, setIdentifySaving] = useState(false);

  if (!tx) return null;

  const handleIdentifySave = async () => {
    if (!tx || !vpa || !identifyName.trim()) return;
    setIdentifySaving(true);
    try {
      await fetch(`/api/transactions/${tx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant: identifyName.trim(),
          category: identifyCategory,
          vpa,
          scope: applyToAll ? "all_vpa" : "single",
        }),
      });
      if (applyToAll) {
        onVpaLabeled?.();
      } else {
        onCategoryUpdated(tx.id, identifyCategory);
      }
      onClose();
    } finally {
      setIdentifySaving(false);
    }
  };

  const handleCategoryClick = (cat: string) => {
    if (cat === tx.category) return;
    setPendingCategory(cat);
    setScope("single");
  };

  const handleConfirm = async () => {
    if (!pendingCategory) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/transactions/${tx.id}/category`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: pendingCategory, scope }),
      });
      if (res.ok) {
        onCategoryUpdated(tx.id, pendingCategory);
        setPendingCategory(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const amountColor = tx.type === "income" ? "text-[#04B488]" : "text-[#ED5533]";
  const displayAmount = fmtAmount(tx.amount, tx.type);
  const catIcon = CATEGORIES.find((c) => c.value === tx.category)?.icon ?? "📦";

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white z-50 shadow-xl flex flex-col overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E9EB]">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{catIcon}</span>
            <div>
              <h2 className="font-semibold text-[#44475B] text-lg leading-tight">{tx.merchant}</h2>
              <span className="text-xs text-[#A1A3AD] uppercase tracking-wide">{tx.category}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-[#A1A3AD] hover:text-[#7C7E8C] text-xl font-light">
            ✕
          </button>
        </div>

        {/* Amount + Date */}
        <div className="px-5 py-4 border-b border-[#E9E9EB]">
          <p className={`text-3xl font-bold ${amountColor}`}>{displayAmount}</p>
          <p className="text-sm text-[#7C7E8C] mt-1">
            {new Date(tx.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            {" · "}
            <span className={`capitalize font-medium ${tx.type === "income" ? "text-[#04B488]" : "text-[#ED5533]"}`}>
              {tx.type}
            </span>
          </p>
        </div>

        {/* VPA Identification section */}
        {hasVpa && (
          <div className="px-5 py-4 border-b border-[#E9E9EB]">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="mb-1 text-sm font-semibold text-amber-800">
                {isUnknown ? "Identify this payment" : "Correct this payment"}
              </p>
              <p className="mb-3 font-mono text-xs text-amber-600 break-all">
                {vpa}
              </p>
              <input
                type="text"
                placeholder="Who is this? (e.g. Landlord, Gym)"
                value={identifyName}
                onChange={(e) => setIdentifyName(e.target.value)}
                className="mb-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
              />
              <select
                value={identifyCategory}
                onChange={(e) => setIdentifyCategory(e.target.value)}
                className="mb-3 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.icon} {c.label}</option>
                ))}
              </select>
              <label className="mb-3 flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyToAll}
                  onChange={(e) => setApplyToAll(e.target.checked)}
                  className="rounded"
                />
                Apply to all payments from this UPI address
              </label>
              <button
                onClick={handleIdentifySave}
                disabled={!identifyName.trim() || identifySaving}
                className="w-full rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-40"
              >
                {identifySaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}

        {/* Category picker */}
        <div className="px-5 py-4 border-b border-[#E9E9EB]">
          <p className="text-xs font-semibold text-[#7C7E8C] uppercase tracking-wide mb-3">Category</p>
          <div className="grid grid-cols-4 gap-2">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                onClick={() => handleCategoryClick(cat.value)}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg text-xs transition-colors ${
                  (pendingCategory ?? tx.category) === cat.value
                    ? "bg-[#E9FAF3] text-[#04B488] font-medium"
                    : "hover:bg-[#F8F8F8] text-[#7C7E8C]"
                }`}
              >
                <span className="text-xl">{cat.icon}</span>
                <span className="truncate w-full text-center">{cat.label}</span>
              </button>
            ))}
          </div>

          {/* Scope selector + confirm — only shown when pending change */}
          {pendingCategory && pendingCategory !== tx.category && (
            <div className="mt-4 p-3 bg-[#F8F8F8] rounded-lg">
              <p className="text-sm text-[#44475B] font-medium mb-2">Apply to:</p>
              <label className="flex items-center gap-2 text-sm text-[#44475B] cursor-pointer mb-1">
                <input
                  type="radio"
                  checked={scope === "single"}
                  onChange={() => setScope("single")}
                  className="accent-[#04B488]"
                />
                Just this transaction
              </label>
              <label className="flex items-center gap-2 text-sm text-[#44475B] cursor-pointer">
                <input
                  type="radio"
                  checked={scope === "all_merchant"}
                  onChange={() => setScope("all_merchant")}
                  className="accent-[#04B488]"
                />
                All <strong className="mx-1">{tx.merchant}</strong> transactions
              </label>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={handleConfirm}
                  disabled={saving}
                  className="flex-1 py-2 bg-[#04B488] text-white text-sm rounded-lg hover:bg-[#03a07a] disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Confirm"}
                </button>
                <button
                  onClick={() => setPendingCategory(null)}
                  className="px-4 py-2 text-sm text-[#7C7E8C] rounded-lg hover:bg-[#E9E9EB]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Source section */}
        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-[#7C7E8C] uppercase tracking-wide mb-2">Source</p>
          {tx.gmailMsgId ? (
            <a
              href={`https://mail.google.com/mail/u/0/#all/${tx.gmailMsgId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-[#04B488] hover:underline"
            >
              View source email ↗
            </a>
          ) : tx.source === "seed" ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#F8F8F8] text-[#7C7E8C] text-xs rounded-full">
              Demo data
            </span>
          ) : tx.source === "manual" ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#F8F8F8] text-[#7C7E8C] text-xs rounded-full">
              Manually added
            </span>
          ) : (
            <span className="text-sm text-[#A1A3AD]">Gmail import</span>
          )}
        </div>
      </div>
    </>
  );
}
