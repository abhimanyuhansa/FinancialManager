"use client";
import { useEffect, useState, useCallback } from "react";
import { TransactionPanel } from "@/components/TransactionPanel";

type Transaction = {
  id: string;
  merchant: string;
  amount: number;
  type: string;
  category: string;
  date: string;
  needsReview: boolean;
  reviewed: boolean;
  source: string;
  tag: string | null;
  gmailMsgId: string | null;
};

const CATEGORY_ICONS: Record<string, string> = {
  food: "🍔", cafe: "☕", transport: "🚗", shopping: "🛍️", clothing: "👕",
  bills: "⚡", phone: "📱", health: "💊", learning: "📚", ott: "📺",
  rent: "🏠", personal: "💆", investment: "📈", work: "💼", income: "💰", other: "📦",
};

const CATEGORIES = [
  "food", "cafe", "transport", "shopping", "clothing", "bills", "phone",
  "health", "learning", "ott", "rent", "personal", "investment", "work", "income", "other",
];

function fmtAmount(amount: number, type: string): string {
  const abs = Math.abs(amount);
  const formatted =
    abs >= 100000 ? `₹${(abs / 100000).toFixed(1)}L`
    : abs >= 1000 ? `₹${(abs / 1000).toFixed(1)}K`
    : `₹${abs}`;
  return type === "income" ? `+${formatted}` : formatted;
}

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [category, setCategory] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

  const fetchTransactions = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (type) params.set("type", type);
    if (category) params.set("category", category);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("page", String(page));

    fetch(`/api/transactions?${params}`)
      .then((r) => r.json())
      .then((d: { transactions: Transaction[]; total: number }) => {
        setTransactions(d.transactions ?? []);
        setTotal(d.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [search, type, category, from, to, page]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedTx(null);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const handleExport = () => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    window.location.href = `/api/transactions/export?${params}`;
  };

  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#44475B]">Transactions</h1>
          <p className="text-sm text-[#7C7E8C] mt-0.5">{total} transaction{total !== 1 ? "s" : ""}</p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#E9E9EB] text-sm font-medium text-[#44475B] hover:bg-[#F8F8F8] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-[#E9E9EB]  p-4 mb-4 flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search merchant..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="flex-1 min-w-[160px] px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
        />
        <select
          value={type}
          onChange={(e) => { setType(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
        >
          <option value="">All types</option>
          <option value="expense">Expenses</option>
          <option value="income">Income</option>
        </select>
        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => { setFrom(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => { setTo(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
        />
        {(search || type || category || from || to) && (
          <button
            onClick={() => { setSearch(""); setType(""); setCategory(""); setFrom(""); setTo(""); setPage(1); }}
            className="px-3 py-2 rounded-lg text-sm text-[#A1A3AD] hover:text-[#44475B] transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-[#E9E9EB]  overflow-hidden">
        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-12 bg-[#F8F8F8] rounded-lg animate-pulse" />
            ))}
          </div>
        ) : transactions.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-[#A1A3AD]">No transactions found.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-50">
                <th className="text-left text-xs font-semibold text-[#A1A3AD] px-5 py-3 uppercase tracking-wide">Date</th>
                <th className="text-left text-xs font-semibold text-[#A1A3AD] px-5 py-3 uppercase tracking-wide">Merchant</th>
                <th className="text-left text-xs font-semibold text-[#A1A3AD] px-5 py-3 uppercase tracking-wide">Category</th>
                <th className="text-right text-xs font-semibold text-[#A1A3AD] px-5 py-3 uppercase tracking-wide">Amount</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr
                  key={tx.id}
                  className="border-b border-gray-50 last:border-0 hover:bg-[#F8F8F8] transition-colors cursor-pointer"
                  onClick={() => setSelectedTx(tx)}
                >
                  <td className="px-5 py-3 text-sm text-[#7C7E8C] whitespace-nowrap">
                    {new Date(tx.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{CATEGORY_ICONS[tx.category] ?? "📦"}</span>
                      <div>
                        <p className="text-sm font-medium text-[#44475B]">
                          {tx.merchant}
                          {tx.source === "seed" && (
                            <span className="ml-2 text-xs px-1.5 py-0.5 bg-[#F8F8F8] text-[#A1A3AD] rounded">Demo</span>
                          )}
                        </p>
                        {tx.needsReview && (
                          <span className="text-xs text-amber-600">⚠ Needs review</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <span className="text-xs bg-[#F8F8F8] text-[#7C7E8C] px-2 py-0.5 rounded-full">
                      {tx.category}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-sm text-right">
                    <span className={tx.type === "income" ? "text-[#04B488] font-semibold" : "text-[#ED5533] font-semibold"}>
                      {fmtAmount(tx.amount, tx.type)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-[#7C7E8C]">
            Page {page} of {totalPages} · {total} results
          </p>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 rounded-lg border border-[#E9E9EB] text-sm text-[#44475B] hover:bg-[#F8F8F8] disabled:opacity-40 transition-colors"
            >
              Previous
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 rounded-lg border border-[#E9E9EB] text-sm text-[#44475B] hover:bg-[#F8F8F8] disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <TransactionPanel
        transaction={selectedTx}
        onClose={() => setSelectedTx(null)}
        onCategoryUpdated={(txId, newCategory) => {
          setTransactions((prev) =>
            prev.map((t) => (t.id === txId ? { ...t, category: newCategory } : t))
          );
          setSelectedTx((prev) => prev && prev.id === txId ? { ...prev, category: newCategory } : prev);
        }}
      />
    </div>
  );
}
