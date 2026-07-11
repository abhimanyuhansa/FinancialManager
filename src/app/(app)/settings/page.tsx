"use client";
import { useEffect, useState, useCallback } from "react";

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

type ParseLogEntry = {
  id: string;
  gmailMsgId: string;
  senderDomain: string;
  emailDate: string | null;
  outcome: string;
  geminiConfidence: number | null;
  parsedMerchant: string | null;
  parsedAmount: number | null;
  wasTruncated: boolean;
  bodyLengthRaw: number;
  bodyLengthSent: number;
  transactionId: string | null;
  createdAt: string;
};

function outcomeColor(outcome: string): string {
  if (outcome === "inserted") return "text-green-700 bg-green-50";
  if (outcome === "upgraded") return "text-blue-700 bg-blue-50";
  if (outcome === "skipped_duplicate") return "text-gray-500 bg-gray-50";
  if (outcome.startsWith("skipped_")) return "text-orange-700 bg-orange-50";
  if (outcome.startsWith("failed_")) return "text-red-700 bg-red-50";
  return "text-gray-600 bg-gray-50";
}

const REPROCESSABLE = new Set([
  "skipped_no_amount",
  "skipped_gemini_null",
  "skipped_filter",
  "skipped_pdf_encrypted",
  "skipped_pdf_failed",
  "failed_gemini_error",
]);

const RANK_LABELS: Record<number, string> = { 1: "Bank", 2: "Payment", 3: "Merchant" };
const STATUS_COLOURS: Record<string, string> = {
  matched: "bg-green-100 text-green-700",
  missing: "bg-red-100 text-red-700",
  mismatch: "bg-amber-100 text-amber-700",
};

export default function SettingsPage() {
  const [tab, setTab] = useState<"filters" | "audit" | "passwords" | "parse-logs">("filters");

  /* ── Email Filters ── */
  const [filters, setFilters] = useState<EmailFilter[]>([]);
  const [filtersLoading, setFiltersLoading] = useState(true);
  const [newType, setNewType] = useState("sender_domain");
  const [newValue, setNewValue] = useState("");
  const [newRank, setNewRank] = useState(3);
  const [newNote, setNewNote] = useState("");
  const [addError, setAddError] = useState("");
  const [addSaving, setAddSaving] = useState(false);

  /* ── Demo Data ── */
  const [clearingDemo, setClearingDemo] = useState(false);
  const [demoCleared, setDemoCleared] = useState(false);

  /* ── Clear All Data ── */
  const [clearingAll, setClearingAll] = useState(false);
  const [allCleared, setAllCleared] = useState(false);

  /* ── Gmail Sync ── */
  const [gmailSyncedAt, setGmailSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");

  /* ── Statement Passwords ── */
  const [passwords, setPasswords] = useState<{
    stored: Array<{ senderDomain: string; updatedAt: string }>;
    pending: string[];
  } | null>(null);
  const [pwLoading, setPwLoading] = useState(false);
  const [newPassword, setNewPassword] = useState<Record<string, string>>({});
  const [savingPw, setSavingPw] = useState<Record<string, boolean>>({});

  const loadPasswords = async () => {
    setPwLoading(true);
    const res = await fetch("/api/settings/statement-passwords");
    const data = await res.json() as { stored: Array<{ senderDomain: string; updatedAt: string }>; pending: string[] };
    setPasswords(data);
    setPwLoading(false);
  };

  const handleSavePassword = async (domain: string) => {
    const pw = newPassword[domain];
    if (!pw) return;
    setSavingPw((prev) => ({ ...prev, [domain]: true }));
    await fetch("/api/settings/statement-passwords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderDomain: domain, password: pw }),
    });
    setNewPassword((prev) => ({ ...prev, [domain]: "" }));
    await loadPasswords();
    setSavingPw((prev) => ({ ...prev, [domain]: false }));
  };

  const handleDeletePassword = async (domain: string) => {
    await fetch(`/api/settings/statement-passwords/${encodeURIComponent(domain)}`, { method: "DELETE" });
    await loadPasswords();
  };

  /* ── Parse Logs ── */
  const [parseLogs, setParseLogs] = useState<ParseLogEntry[]>([]);
  const [parseLogsTotal, setParseLogsTotal] = useState(0);
  const [parseLogsPage, setParseLogsPage] = useState(1);
  const [parseLogsLoading, setParseLogsLoading] = useState(false);
  const [parseOutcomeFilter, setParseOutcomeFilter] = useState("");
  const [parseDomainFilter, setParseDomainFilter] = useState("");
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);

  const loadParseLogs = async (page = 1) => {
    setParseLogsLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (parseOutcomeFilter) params.set("outcome", parseOutcomeFilter);
    if (parseDomainFilter) params.set("domain", parseDomainFilter);
    const res = await fetch(`/api/settings/parse-logs?${params}`);
    const data = await res.json() as { logs: ParseLogEntry[]; total: number };
    setParseLogs(data.logs ?? []);
    setParseLogsTotal(data.total ?? 0);
    setParseLogsPage(page);
    setParseLogsLoading(false);
  };

  const handleReprocess = async (id: string) => {
    setReprocessingId(id);
    const res = await fetch(`/api/settings/parse-logs/${id}/reprocess`, { method: "POST" });
    const data = await res.json() as { outcome?: string; error?: string };
    setReprocessingId(null);
    if (data.error) {
      alert(`Reprocess failed: ${data.error}`);
    } else {
      await loadParseLogs(parseLogsPage);
    }
  };

  const handleClearDemo = async () => {
    if (!confirm("This will permanently delete all demo transactions. Continue?")) return;
    setClearingDemo(true);
    try {
      const res = await fetch("/api/transactions/demo", { method: "DELETE" });
      const data = await res.json() as { deleted: number };
      setDemoCleared(true);
      alert(`Deleted ${data.deleted} demo transaction${data.deleted !== 1 ? "s" : ""}.`);
    } finally {
      setClearingDemo(false);
    }
  };

  const handleClearAll = async () => {
    if (!confirm("This will permanently delete ALL your transactions, sync history, and assets. This cannot be undone.")) return;
    setClearingAll(true);
    try {
      const res = await fetch("/api/user/data", { method: "DELETE" });
      const text = await res.text();
      if (!res.ok) {
        alert(`Failed to clear data (${res.status}): ${text}`);
        return;
      }
      const data = JSON.parse(text) as { deleted: { transactions: number; syncJobs: number; parseLogs: number; assets: number } };
      setAllCleared(true);
      alert(`Cleared: ${data.deleted.transactions} transactions, ${data.deleted.syncJobs} sync jobs, ${data.deleted.parseLogs} parse logs, ${data.deleted.assets} assets.`);
    } catch (e) {
      alert(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setClearingAll(false);
    }
  };

  const loadUserInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/user/info");
      if (!res.ok) return;
      const data = await res.json() as { gmailSyncedAt: string | null };
      setGmailSyncedAt(data.gmailSyncedAt);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadUserInfo(); }, [loadUserInfo]);

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncMessage("");
    try {
      const res = await fetch("/api/gmail/sync/start", { method: "POST" });
      const data = await res.json() as { jobId?: string; error?: string; running?: boolean };
      if (data.running) {
        setSyncMessage("Sync already in progress — check the banner at the top.");
      } else if (data.jobId) {
        setSyncMessage("Sync started! Watch the banner at the top of the page.");
      } else {
        setSyncMessage(data.error ?? "Failed to start sync.");
      }
    } finally {
      setSyncing(false);
    }
  };

  const fetchFilters = () => {
    setFiltersLoading(true);
    fetch("/api/settings/filters")
      .then((r) => r.json())
      .then((d: { filters: EmailFilter[] }) => setFilters(d.filters ?? []))
      .finally(() => setFiltersLoading(false));
  };

  useEffect(() => { if (tab === "filters") fetchFilters(); }, [tab]);
  useEffect(() => { if (tab === "passwords") { void loadPasswords(); } }, [tab]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === "parse-logs") { void loadParseLogs(1); } }, [tab, parseOutcomeFilter, parseDomainFilter]);

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
        {(["filters", "audit", "passwords", "parse-logs"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === t ? "text-[#5b7cfa] border-b-2 border-[#5b7cfa]" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "filters" ? "Email Filters" : t === "audit" ? "Reconciliation Audit" : t === "passwords" ? "Statement Passwords" : "Parse Logs"}
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

      {/* ── Statement Passwords Tab ── */}
      {tab === "passwords" && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-1">Statement Passwords</h2>
          <p className="text-sm text-gray-500 mb-6">
            Some bank statements arrive as password-protected PDFs. Enter the password for each sender so Financial Manager can read them.
          </p>

          {pwLoading && <p className="text-sm text-gray-400">Loading…</p>}

          {passwords && (
            <>
              {passwords.pending.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-xs font-semibold text-orange-700 uppercase tracking-wide mb-3">
                    ⚠️ Encrypted statements found ({passwords.pending.length})
                  </h3>
                  <div className="flex flex-col gap-2">
                    {passwords.pending.map((domain) => (
                      <div key={domain} className="flex items-center gap-3 p-3 bg-orange-50 border border-orange-200 rounded-xl">
                        <span className="flex-1 text-sm font-medium text-gray-700 font-mono">{domain}</span>
                        <input
                          type="password"
                          placeholder="Enter password"
                          value={newPassword[domain] ?? ""}
                          onChange={(e) => setNewPassword((prev) => ({ ...prev, [domain]: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && void handleSavePassword(domain)}
                          className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-[#5b7cfa]"
                        />
                        <button
                          onClick={() => void handleSavePassword(domain)}
                          disabled={savingPw[domain] || !newPassword[domain]}
                          className="px-4 py-1.5 bg-[#5b7cfa] text-white text-sm rounded-xl hover:bg-[#4a6be8] disabled:opacity-50 transition-colors"
                        >
                          {savingPw[domain] ? "Saving…" : "Save"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {passwords.stored.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-50">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Stored passwords</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {passwords.stored.map((entry) => (
                      <div key={entry.senderDomain} className="px-5 py-2.5 flex items-center gap-4">
                        <span className="flex-1 text-sm text-gray-900 font-mono">{entry.senderDomain}</span>
                        <span className="text-xs text-gray-400">
                          {new Date(entry.updatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                        </span>
                        <button
                          onClick={() => void handleDeletePassword(entry.senderDomain)}
                          className="text-xs text-red-400 hover:text-red-600 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {passwords.pending.length === 0 && passwords.stored.length === 0 && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-12 text-center">
                  <p className="text-sm text-gray-400">No encrypted statements found yet.</p>
                  <p className="text-xs text-gray-300 mt-1">Passwords will appear here after a Gmail sync encounters a protected PDF.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Parse Logs Tab ── */}
      {tab === "parse-logs" && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-1">Parse Logs</h2>
          <p className="text-sm text-gray-500 mb-4">
            Every email that entered the parsing pipeline. Use this to debug missing transactions. Logs are kept for 30 days.
          </p>

          <div className="flex flex-wrap gap-2 mb-4">
            <select
              value={parseOutcomeFilter}
              onChange={(e) => setParseOutcomeFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#5b7cfa]"
            >
              <option value="">All outcomes</option>
              <option value="inserted">Inserted</option>
              <option value="upgraded">Upgraded</option>
              <option value="skipped_duplicate">Skipped (duplicate)</option>
              <option value="skipped_no_amount">Skipped (no amount)</option>
              <option value="skipped_gemini_null">Skipped (Gemini null)</option>
              <option value="skipped_filter">Skipped (filter)</option>
              <option value="skipped_pdf_encrypted">Skipped (encrypted PDF)</option>
              <option value="skipped_pdf_failed">Skipped (PDF error)</option>
              <option value="failed_gemini_error">Failed (Gemini error)</option>
            </select>
            <input
              type="text"
              placeholder="Filter by domain…"
              value={parseDomainFilter}
              onChange={(e) => setParseDomainFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#5b7cfa] w-48"
            />
          </div>

          {parseLogsLoading ? (
            <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-gray-100 rounded-xl animate-pulse" />)}</div>
          ) : (
            <>
              <p className="text-xs text-gray-400 mb-2">{parseLogsTotal} entries</p>
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                        <th className="text-left px-5 py-3">Date</th>
                        <th className="text-left px-5 py-3">Domain</th>
                        <th className="text-left px-5 py-3">Outcome</th>
                        <th className="text-left px-5 py-3">Merchant</th>
                        <th className="text-right px-5 py-3">Amount</th>
                        <th className="text-center px-3 py-3">Trunc</th>
                        <th className="px-3 py-3"></th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {parseLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-gray-50">
                          <td className="px-5 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                            {new Date(log.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                          </td>
                          <td className="px-5 py-2.5 text-sm text-gray-700">{log.senderDomain}</td>
                          <td className="px-5 py-2.5">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${outcomeColor(log.outcome)}`}>
                              {log.outcome}
                            </span>
                          </td>
                          <td className="px-5 py-2.5 text-sm text-gray-700">{log.parsedMerchant ?? "—"}</td>
                          <td className="px-5 py-2.5 text-sm text-right text-gray-700">
                            {log.parsedAmount != null ? `₹${log.parsedAmount}` : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {log.wasTruncated ? (
                              <span title={`${log.bodyLengthRaw} → ${log.bodyLengthSent} chars`} className="text-orange-500 cursor-help text-xs">
                                ⚠️
                              </span>
                            ) : <span className="text-gray-300 text-xs">—</span>}
                          </td>
                          <td className="px-3 py-2.5">
                            <a
                              href={`https://mail.google.com/mail/u/0/#all/${log.gmailMsgId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#5b7cfa] hover:underline text-xs"
                            >
                              View ↗
                            </a>
                          </td>
                          <td className="px-3 py-2.5">
                            {REPROCESSABLE.has(log.outcome) && (
                              <button
                                onClick={() => void handleReprocess(log.id)}
                                disabled={reprocessingId === log.id}
                                className="text-xs px-2 py-1 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                              >
                                {reprocessingId === log.id ? "…" : "Reprocess"}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {parseLogsTotal > 50 && (
                <div className="flex justify-between items-center mt-4">
                  <button
                    disabled={parseLogsPage <= 1}
                    onClick={() => void loadParseLogs(parseLogsPage - 1)}
                    className="text-sm text-[#5b7cfa] disabled:text-gray-300"
                  >
                    ← Previous
                  </button>
                  <span className="text-sm text-gray-500">
                    Page {parseLogsPage} of {Math.ceil(parseLogsTotal / 50)}
                  </span>
                  <button
                    disabled={parseLogsPage >= Math.ceil(parseLogsTotal / 50)}
                    onClick={() => void loadParseLogs(parseLogsPage + 1)}
                    className="text-sm text-[#5b7cfa] disabled:text-gray-300"
                  >
                    Next →
                  </button>
                </div>
              )}

              {parseLogs.length === 0 && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-12 text-center mt-2">
                  <p className="text-sm text-gray-400">No parse logs found.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Gmail Sync */}
      <div className="mt-8 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Gmail Sync</h3>
        {gmailSyncedAt ? (
          <p className="text-sm text-gray-500 mb-3">
            Last synced:{" "}
            <span className="text-gray-700 font-medium">
              {new Date(gmailSyncedAt).toLocaleString("en-IN", {
                day: "numeric", month: "short", year: "numeric",
                hour: "2-digit", minute: "2-digit",
              })}
            </span>
          </p>
        ) : (
          <p className="text-sm text-gray-400 mb-3">No sync completed yet.</p>
        )}
        <button
          onClick={handleSyncNow}
          disabled={syncing}
          className="px-4 py-2 text-sm bg-[#5b7cfa] text-white rounded-lg hover:bg-[#4a6be8] disabled:opacity-50 transition-colors"
        >
          {syncing ? "Starting…" : "Sync now"}
        </button>
        {syncMessage && <p className="text-xs text-gray-500 mt-2">{syncMessage}</p>}
      </div>

      {/* Demo Data */}
      <div className="mt-8 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Demo Data</h3>
        <p className="text-sm text-gray-500 mb-3">
          Remove the sample transactions that were pre-loaded to demonstrate the app.
        </p>
        <button
          onClick={handleClearDemo}
          disabled={clearingDemo || demoCleared}
          className="px-4 py-2 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
        >
          {demoCleared ? "Demo data cleared" : clearingDemo ? "Clearing…" : "Clear Demo Data"}
        </button>
      </div>

      {/* Clear All Data */}
      <div className="mt-4 bg-white rounded-2xl border border-red-100 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-red-700 mb-2">Danger Zone</h3>
        <p className="text-sm text-gray-500 mb-3">
          Permanently delete all transactions, sync history, parse logs, and assets. Use this to start fresh. This cannot be undone.
        </p>
        <button
          onClick={handleClearAll}
          disabled={clearingAll || allCleared}
          className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          {allCleared ? "All data cleared" : clearingAll ? "Clearing…" : "Clear All Data"}
        </button>
      </div>

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
