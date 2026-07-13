"use client";
import { useState } from "react";
import { useCategories, invalidateCategoryCache } from "@/hooks/useCategories";
import { CategoryIcon } from "@/components/CategoryIcon";
import { IconPicker } from "@/components/IconPicker";

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

function fmtAmount(amount: number, type: string): string {
  const abs = Math.abs(amount);
  const formatted =
    abs >= 100000 ? `₹${(abs / 100000).toFixed(1)}L`
    : abs >= 1000 ? `₹${(abs / 1000).toFixed(1)}K`
    : `₹${abs}`;
  return type === "income" ? `+${formatted}` : formatted;
}

export function TransactionPanel({ transaction: tx, onClose, onCategoryUpdated, onVpaLabeled }: Props) {
  const { categories, refetch } = useCategories();
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

  // Add-category inline form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatIcon, setNewCatIcon] = useState("");
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState("");

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

  const handleAddCategory = async () => {
    if (!newCatName.trim()) return;
    const slug = newCatName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    setAddSaving(true);
    setAddError("");
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCatName.trim(), slug, icon: newCatIcon }),
      });
      if (res.ok) {
        invalidateCategoryCache();
        refetch();
        setNewCatName("");
        setNewCatIcon("");
        setShowAddForm(false);
      } else {
        const d = await res.json() as { error?: string };
        setAddError(d.error ?? "Failed to add category");
      }
    } finally {
      setAddSaving(false);
    }
  };

  const amountColor = tx.type === "income" ? "text-[#04B488]" : "text-[#ED5533]";
  const displayAmount = fmtAmount(tx.amount, tx.type);
  const currentCat = categories.find((c) => c.slug === tx.category);

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white z-50 shadow-xl flex flex-col overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E9EB]">
          <div className="flex items-center gap-3">
            <CategoryIcon
              name={currentCat?.icon ?? ""}
              slug={tx.category}
              label={tx.category}
              size={28}
              className="text-[#44475B]"
            />
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
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>{c.name}</option>
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
            {categories.map((cat) => (
              <button
                key={cat.slug}
                onClick={() => handleCategoryClick(cat.slug)}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg text-xs transition-colors ${
                  (pendingCategory ?? tx.category) === cat.slug
                    ? "bg-[#E9FAF3] text-[#04B488] font-medium"
                    : "hover:bg-[#F8F8F8] text-[#7C7E8C]"
                }`}
              >
                <CategoryIcon
                  name={cat.icon}
                  slug={cat.slug}
                  label={cat.name}
                  size={20}
                  className={(pendingCategory ?? tx.category) === cat.slug ? "text-[#04B488]" : "text-[#7C7E8C]"}
                />
                <span className="truncate w-full text-center">{cat.name}</span>
              </button>
            ))}

            {/* Add new category button */}
            <button
              onClick={() => setShowAddForm((v) => !v)}
              className="flex flex-col items-center gap-1 p-2 rounded-lg text-xs hover:bg-[#F8F8F8] text-[#A1A3AD] border border-dashed border-[#E9E9EB] transition-colors"
            >
              <span className="text-xl">+</span>
              <span className="truncate w-full text-center">Add</span>
            </button>
          </div>

          {/* Inline add-category form */}
          {showAddForm && (
            <div className="mt-3 p-3 bg-[#F8F8F8] rounded-lg">
              <p className="text-sm font-medium text-[#44475B] mb-2">New category</p>
              <input
                type="text"
                placeholder="Name (e.g. Fitness)"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                className="mb-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
              />
              <p className="text-xs text-[#7C7E8C] mb-2">Pick an icon (optional)</p>
              <IconPicker selected={newCatIcon} onSelect={setNewCatIcon} />
              {addError && <p className="text-xs text-red-500 mt-1">{addError}</p>}
              <div className="flex gap-2 mt-3">
                <button
                  onClick={handleAddCategory}
                  disabled={!newCatName.trim() || addSaving}
                  className="flex-1 py-2 bg-[#04B488] text-white text-sm rounded-lg hover:bg-[#03a07a] disabled:opacity-50"
                >
                  {addSaving ? "Saving…" : "Add category"}
                </button>
                <button
                  onClick={() => { setShowAddForm(false); setNewCatName(""); setNewCatIcon(""); setAddError(""); }}
                  className="px-4 py-2 text-sm text-[#7C7E8C] rounded-lg hover:bg-[#E9E9EB]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Scope selector + confirm — only shown when pending change */}
          {pendingCategory && pendingCategory !== tx.category && (
            <div className="mt-4 p-3 bg-[#F8F8F8] rounded-lg">
              <p className="text-sm text-[#44475B] font-medium mb-2">Apply to:</p>
              <label className="flex items-center gap-2 text-sm text-[#44475B] cursor-pointer mb-1">
                <input type="radio" checked={scope === "single"} onChange={() => setScope("single")} className="accent-[#04B488]" />
                Just this transaction
              </label>
              <label className="flex items-center gap-2 text-sm text-[#44475B] cursor-pointer">
                <input type="radio" checked={scope === "all_merchant"} onChange={() => setScope("all_merchant")} className="accent-[#04B488]" />
                All <strong className="mx-1">{tx.merchant}</strong> transactions
              </label>
              <div className="flex gap-2 mt-3">
                <button onClick={handleConfirm} disabled={saving} className="flex-1 py-2 bg-[#04B488] text-white text-sm rounded-lg hover:bg-[#03a07a] disabled:opacity-50">
                  {saving ? "Saving…" : "Confirm"}
                </button>
                <button onClick={() => setPendingCategory(null)} className="px-4 py-2 text-sm text-[#7C7E8C] rounded-lg hover:bg-[#E9E9EB]">
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
