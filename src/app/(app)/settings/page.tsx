"use client";
import { useEffect, useState } from "react";

type EmailFilter = {
  id: string;
  type: string;
  value: string;
  sourceRank: number;
  isActive: boolean;
  note: string | null;
  addedAt: string;
};

type ReconciliationLog = {
  id: string;
  statementGmailMsgId: string;
  statementDate: string;
  statementMerchant: string;
  statementAmount: number;
  matchedTransactionId: string | null;
  status: string;
  mismatchDetails: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

const RANK_LABELS: Record<number, string> = { 1: "Bank", 2: "Payment", 3: "Merchant" };
const STATUS_COLOURS: Record<string, string> = {
  matched: "bg-green-100 text-green-700",
  missing: "bg-red-100 text-red-700",
  mismatch: "bg-amber-100 text-amber-700",
};

export default function SettingsPage() {
  const [tab, setTab] = useState<"filters" | "audit">("filters");

  /* ── Email Filters ── */
  const [filters, setFilters] = useState<EmailFilter[]>([]);
  const [filtersLoading, setFiltersLoading] = useState(true);
  const [newType, setNewType] = useState("sender_domain");
  const [newValue, setNewValue] = useState("");
  const [newRank, setNewRank] = useState(3);
  const [newNote, setNewNote] = useState("");
  const [addError, setAddError] = useState("");
  const [addSaving, setAddSaving] = useState(false);

  const fetchFilters = () => {
    setFiltersLoading(true);
    fetch("/api/settings/filters")
      .then((r) => r.json())
      .then((d: { filters: EmailFilter[] }) => setFilters(d.filters ?? []))
      .finally(() => setFiltersLoading(false));
  };

  useEffect(() => { if (tab === "filters") fetchFilters(); }, [tab]);

  const handleAddFilter = async () => {
    if (!newValue.trim()) { setAddError("Value is required"); return; }
    setAddSaving(true); setAddError("");
    try {
      const res = await fetch("/api/settings/filters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newType, value: newValue.trim(), sourceRank: newRank, note: newNote.trim() || null }),
      });
      if (!res.ok) { const d = await res.json() as { error: string }; throw new Error(d.error); }
      setNewValue(""); setNewNote(""); fetchFilters();
    } catch (e) { setAddError(e instanceof Error ? e.message : "Failed to add filter"); }
    finally { setAddSaving(false); }
  };

  const toggleFilter = async (id: string, isActive: boolean) => {
    await fetch(`/api/settings/filters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !isActive }),
    });
    fetchFilters();
  };

  const deleteFilter = async (id: string) => {
    if (!confirm("Delete this filter? This affects future syncs.")) return;
    await fetch(`/api/settings/filters/${id}`, { method: "DELETE" });
    fetchFilters();
  };

  /* ── Audit ── */
  const [logs, setLogs] = useState<ReconciliationLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  useEffect(() => {
    if (tab === "audit") {
      setLogsLoading(true);
      fetch("/api/gmail/reconcile")
        .then((r) => r.json())
        .then((d: { logs: ReconciliationLog[] }) => setLogs(d.logs ?? []))
        .finally(() => setLogsLoading(false));
    }
  }, [tab]);

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-100">
        {(["filters", "audit"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === t ? "text-[#5b7cfa] border-b-2 border-[#5b7cfa]" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "filters" ? "Email Filters" : "Reconciliation Audit"}
          </button>
        ))}
      </div>

      {/* ── Email Filters Tab ── */}
      {tab === "filters" && (
        <>
          {/* Add filter form */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Add Filter</h2>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Type</label>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#5b7cfa]"
                >
                  <option value="sender_domain">Sender Domain</option>
                  <option value="sender_email">Sender Email</option>
                  <option value="subject_keyword">Subject Keyword</option>
                </select>
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-xs text-gray-500 mb-1">Value</label>
                <input
                  type="text"
                  placeholder="e.g. hdfcbank.com"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddFilter()}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#5b7cfa]"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Rank</label>
                <select
                  value={newRank}
                  onChange={(e) => setNewRank(parseInt(e.target.value, 10))}
                  className="px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#5b7cfa]"
                >
                  <option value={1}>1 — Bank</option>
                  <option value={2}>2 — Payment</option>
                  <option value={3}>3 — Merchant</option>
                </select>
              </div>
              <div className="flex-1 min-w-[120px]">
                <label className="block text-xs text-gray-500 mb-1">Note (optional)</label>
                <input
                  type="text"
                  placeholder="Description"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#5b7cfa]"
                />
              </div>
              <button
                onClick={handleAddFilter}
                disabled={addSaving}
                className="px-4 py-2 bg-[#5b7cfa] text-white rounded-xl text-sm font-medium hover:bg-[#4a6be8] disabled:opacity-60 transition-colors"
              >
                {addSaving ? "Adding..." : "Add"}
              </button>
            </div>
            {addError && <p className="text-xs text-red-600 mt-2">{addError}</p>}
          </div>

          {/* Filters list */}
          {filtersLoading ? (
            <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-gray-100 rounded-xl animate-pulse" />)}</div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-50 flex gap-4">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-28">Type</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex-1">Value</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-20">Rank</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-16">Active</span>
                <span className="w-14" />
              </div>
              <div className="divide-y divide-gray-50">
                {filters.map((f) => (
                  <div key={f.id} className={`px-5 py-2.5 flex items-center gap-4 ${!f.isActive ? "opacity-50" : ""}`}>
                    <span className="text-xs text-gray-500 w-28 truncate">{f.type.replace("_", " ")}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900 font-mono truncate">{f.value}</p>
                      {f.note && <p className="text-xs text-gray-400 truncate">{f.note}</p>}
                    </div>
                    <span className="text-xs text-gray-500 w-20">{RANK_LABELS[f.sourceRank] ?? f.sourceRank}</span>
                    <button
                      onClick={() => toggleFilter(f.id, f.isActive)}
                      className={`w-16 text-xs px-2 py-1 rounded-full font-medium transition-colors ${
                        f.isActive ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                      }`}
                    >
                      {f.isActive ? "On" : "Off"}
                    </button>
                    <button
                      onClick={() => deleteFilter(f.id)}
                      className="w-14 text-xs text-red-400 hover:text-red-600 transition-colors text-right"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Audit Tab ── */}
      {tab === "audit" && (
        <>
          {logsLoading ? (
            <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-gray-100 rounded-xl animate-pulse" />)}</div>
          ) : logs.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-12 text-center">
              <p className="text-sm text-gray-400">No reconciliation runs yet.</p>
              <p className="text-xs text-gray-300 mt-1">Use POST /api/gmail/reconcile with a statement email ID to reconcile.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-50 flex gap-4">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-24">Date</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex-1">Merchant</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-24 text-right">Amount</span>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-20">Status</span>
              </div>
              <div className="divide-y divide-gray-50">
                {logs.map((log) => (
                  <div key={log.id} className="px-5 py-2.5 flex items-center gap-4">
                    <span className="text-xs text-gray-500 w-24 whitespace-nowrap">
                      {new Date(log.statementDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900 truncate">{log.statementMerchant}</p>
                      {log.mismatchDetails && (
                        <p className="text-xs text-amber-600 truncate">{log.mismatchDetails}</p>
                      )}
                    </div>
                    <span className="text-sm font-medium text-gray-900 w-24 text-right">
                      ₹{log.statementAmount.toLocaleString("en-IN")}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium w-20 text-center ${STATUS_COLOURS[log.status] ?? "bg-gray-100 text-gray-600"}`}>
                      {log.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Dev-only advance sync */}
      {process.env.NODE_ENV === "development" && (
        <div className="mt-8 p-4 border border-dashed border-gray-300 rounded-lg">
          <p className="text-xs text-gray-500 font-mono mb-2">DEV ONLY</p>
          <button
            onClick={async () => {
              const secret = process.env.NEXT_PUBLIC_CRON_SECRET ?? "";
              const res = await fetch(`/api/gmail/sync/advance?secret=${secret}`);
              const data = await res.json();
              alert(JSON.stringify(data, null, 2));
            }}
            className="px-4 py-2 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-700"
          >
            Advance Sync (dev)
          </button>
        </div>
      )}
    </div>
  );
}
