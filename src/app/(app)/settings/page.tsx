"use client";
import { useEffect, useState, useCallback } from "react";
import { CategoryIcon } from "@/components/CategoryIcon";
import { IconPicker } from "@/components/IconPicker";
import { invalidateCategoryCache } from "@/hooks/useCategories";

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

type GmailQueryKeyword = {
  id: string;
  type: string;
  value: string;
  isActive: boolean;
  isDefault: boolean;
  addedAt: string;
};

type ExclusionRule = {
  id: string;
  type: string;
  value: string;
  isActive: boolean;
  note: string | null;
  addedAt: string;
};

type SubCategoryEntry = {
  id: string;
  category: string;
  subCategory: string;
  isDefault: boolean;
  addedBy: string;
};

type RetroPeriod = "1m" | "3m" | "6m" | "12m";

function outcomeColor(outcome: string): string {
  if (outcome === "inserted") return "text-[#04B488] bg-green-50";
  if (outcome === "upgraded") return "text-blue-700 bg-blue-50";
  if (outcome === "skipped_duplicate") return "text-[#7C7E8C] bg-[#F8F8F8]";
  if (outcome.startsWith("skipped_")) return "text-orange-700 bg-orange-50";
  if (outcome.startsWith("failed_") || outcome === "parse_failed") return "text-[#ED5533] bg-red-50";
  return "text-[#7C7E8C] bg-[#F8F8F8]";
}

const REPROCESSABLE = new Set([
  "skipped_no_amount",
  "skipped_gemini_null",
  "skipped_filter",
  "skipped_pdf_encrypted",
  "skipped_pdf_failed",
  "failed_gemini_error",
  "parse_failed",
  "not_transaction",
]);

const RANK_LABELS: Record<number, string> = { 1: "Bank", 2: "Payment", 3: "Merchant" };
const STATUS_COLOURS: Record<string, string> = {
  matched: "bg-green-100 text-[#04B488]",
  missing: "bg-red-100 text-[#ED5533]",
  mismatch: "bg-amber-100 text-amber-700",
};

const VALID_CATEGORIES = [
  "food", "transport", "shopping", "entertainment", "utilities",
  "health", "finance", "travel", "groceries", "income", "other",
];

export default function SettingsPage() {
  const [tab, setTab] = useState<"filters" | "audit" | "passwords" | "parse-logs" | "categories">("filters");

  /* ── Categories ── */
  type CategoryRow = { id: string; slug: string; name: string; icon: string; isDefault: boolean };
  const [catList, setCatList] = useState<CategoryRow[]>([]);
  const [catLoading, setCatLoading] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatIcon, setNewCatIcon] = useState("");
  const [catAddSaving, setCatAddSaving] = useState(false);
  const [catAddError, setCatAddError] = useState("");

  const fetchCategories = useCallback(async () => {
    setCatLoading(true);
    const res = await fetch("/api/categories");
    const d = await res.json() as { categories: CategoryRow[] };
    setCatList(d.categories ?? []);
    setCatLoading(false);
  }, []);

  const handleAddCat = async () => {
    if (!newCatName.trim()) return;
    const slug = newCatName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    setCatAddSaving(true);
    setCatAddError("");
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCatName.trim(), slug, icon: newCatIcon }),
      });
      if (res.ok) {
        invalidateCategoryCache();
        setNewCatName("");
        setNewCatIcon("");
        await fetchCategories();
      } else {
        const d = await res.json() as { error?: string };
        setCatAddError(d.error ?? "Failed to add category");
      }
    } finally {
      setCatAddSaving(false);
    }
  };

  useEffect(() => {
    if (tab === "categories") void fetchCategories();
  }, [tab, fetchCategories]);

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

  /* ── Gmail Query Keywords ── */
  const [gmailKeywords, setGmailKeywords] = useState<GmailQueryKeyword[]>([]);
  const [gmailKeywordsLoading, setGmailKeywordsLoading] = useState(false);
  const [newKwType, setNewKwType] = useState("from");
  const [newKwValue, setNewKwValue] = useState("");
  const [addingKw, setAddingKw] = useState(false);

  /* ── Exclusion Rules ── */
  const [exclusionRules, setExclusionRules] = useState<ExclusionRule[]>([]);
  const [exclusionLoading, setExclusionLoading] = useState(false);
  const [newExType, setNewExType] = useState("sender_domain");
  const [newExValue, setNewExValue] = useState("");
  const [newExNote, setNewExNote] = useState("");
  const [addingEx, setAddingEx] = useState(false);

  /* ── Sub-Category Taxonomy ── */
  const [subcategories, setSubcategories] = useState<SubCategoryEntry[]>([]);
  const [subcatLoading, setSubcatLoading] = useState(false);
  const [newSubcatCategory, setNewSubcatCategory] = useState("food");
  const [newSubcatValue, setNewSubcatValue] = useState("");
  const [addingSubcat, setAddingSubcat] = useState(false);

  /* ── Retro Re-sync ── */
  const [retroPeriod, setRetroPeriod] = useState<RetroPeriod>("6m");
  const [retroSyncing, setRetroSyncing] = useState(false);
  const [retroMessage, setRetroMessage] = useState("");

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

  /* ── Gmail Query Keywords handlers ── */
  const loadGmailKeywords = useCallback(async () => {
    setGmailKeywordsLoading(true);
    const res = await fetch("/api/settings/gmail-query");
    const data = await res.json() as GmailQueryKeyword[];
    setGmailKeywords(Array.isArray(data) ? data : []);
    setGmailKeywordsLoading(false);
  }, []);

  useEffect(() => { void loadGmailKeywords(); }, [loadGmailKeywords]);

  const handleAddKeyword = async () => {
    if (!newKwValue.trim()) return;
    setAddingKw(true);
    await fetch("/api/settings/gmail-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: newKwType, value: newKwValue.trim() }),
    });
    setNewKwValue("");
    await loadGmailKeywords();
    setAddingKw(false);
  };

  const toggleKeyword = async (id: string, isActive: boolean) => {
    await fetch("/api/settings/gmail-query", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, isActive: !isActive }),
    });
    await loadGmailKeywords();
  };

  const deleteKeyword = async (id: string) => {
    if (!confirm("Remove this keyword from Gmail query?")) return;
    await fetch("/api/settings/gmail-query", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await loadGmailKeywords();
  };

  /* ── Exclusion Rules handlers ── */
  const loadExclusionRules = useCallback(async () => {
    setExclusionLoading(true);
    const res = await fetch("/api/settings/exclusion-rules");
    const data = await res.json() as ExclusionRule[];
    setExclusionRules(Array.isArray(data) ? data : []);
    setExclusionLoading(false);
  }, []);

  useEffect(() => { void loadExclusionRules(); }, [loadExclusionRules]);

  const handleAddExclusion = async () => {
    if (!newExValue.trim()) return;
    setAddingEx(true);
    await fetch("/api/settings/exclusion-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: newExType, value: newExValue.trim(), note: newExNote.trim() || undefined }),
    });
    setNewExValue(""); setNewExNote("");
    await loadExclusionRules();
    setAddingEx(false);
  };

  const toggleExclusion = async (id: string, isActive: boolean) => {
    await fetch("/api/settings/exclusion-rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, isActive: !isActive }),
    });
    await loadExclusionRules();
  };

  const deleteExclusion = async (id: string) => {
    if (!confirm("Remove this exclusion rule?")) return;
    await fetch("/api/settings/exclusion-rules", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await loadExclusionRules();
  };

  /* ── Sub-Category Taxonomy handlers ── */
  const loadSubcategories = useCallback(async () => {
    setSubcatLoading(true);
    const res = await fetch("/api/settings/subcategories");
    const data = await res.json() as SubCategoryEntry[];
    setSubcategories(Array.isArray(data) ? data : []);
    setSubcatLoading(false);
  }, []);

  useEffect(() => { void loadSubcategories(); }, [loadSubcategories]);

  const handleAddSubcat = async () => {
    if (!newSubcatValue.trim()) return;
    setAddingSubcat(true);
    await fetch("/api/settings/subcategories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: newSubcatCategory, subCategory: newSubcatValue.trim() }),
    });
    setNewSubcatValue("");
    await loadSubcategories();
    setAddingSubcat(false);
  };

  const deleteSubcat = async (id: string) => {
    if (!confirm("Remove this sub-category?")) return;
    const res = await fetch("/api/settings/subcategories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const data = await res.json() as { error: string };
      alert(data.error);
      return;
    }
    await loadSubcategories();
  };

  /* ── Retro Re-sync ── */
  const handleRetroSync = async () => {
    if (!confirm(`This will queue a re-sync of the last ${retroPeriod === "1m" ? "1 month" : retroPeriod === "3m" ? "3 months" : retroPeriod === "6m" ? "6 months" : "12 months"} of emails. Existing transactions are not duplicated. Continue?`)) return;
    setRetroSyncing(true);
    setRetroMessage("");
    try {
      const res = await fetch("/api/gmail/sync/retro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: retroPeriod }),
      });
      const data = await res.json() as { jobId?: string; error?: string };
      if (data.jobId) {
        setRetroMessage(`Retro sync started (job ${data.jobId.slice(0, 8)}…). Watch the banner at the top of the page.`);
      } else {
        setRetroMessage(data.error ?? "Failed to start retro sync.");
      }
    } catch {
      setRetroMessage("Failed to start retro sync.");
    } finally {
      setRetroSyncing(false);
    }
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

  /* group subcategories by category */
  const subcatByCategory = subcategories.reduce<Record<string, SubCategoryEntry[]>>((acc, s) => {
    (acc[s.category] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-semibold text-[#44475B] mb-6">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-[#E9E9EB]">
        {(["filters", "audit", "passwords", "parse-logs", "categories"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              tab === t ? "text-[#04B488] border-b-2 border-[#04B488]" : "text-[#7C7E8C] hover:text-[#44475B]"
            }`}
          >
            {t === "filters" ? "Email Filters" : t === "audit" ? "Reconciliation Audit" : t === "passwords" ? "Statement Passwords" : t === "parse-logs" ? "Parse Logs" : "Categories"}
          </button>
        ))}
      </div>

      {/* ── Email Filters Tab ── */}
      {tab === "filters" && (
        <>
          {/* Add filter form */}
          <div className="bg-white rounded-lg border border-[#E9E9EB]  p-5 mb-6">
            <h2 className="text-sm font-semibold text-[#44475B] mb-3">Add Filter</h2>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="block text-xs text-[#7C7E8C] mb-1">Type</label>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
                >
                  <option value="sender_domain">Sender Domain</option>
                  <option value="sender_email">Sender Email</option>
                  <option value="subject_keyword">Subject Keyword</option>
                </select>
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-xs text-[#7C7E8C] mb-1">Value</label>
                <input
                  type="text"
                  placeholder="e.g. hdfcbank.com"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddFilter()}
                  className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
                />
              </div>
              <div>
                <label className="block text-xs text-[#7C7E8C] mb-1">Rank</label>
                <select
                  value={newRank}
                  onChange={(e) => setNewRank(parseInt(e.target.value, 10))}
                  className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
                >
                  <option value={1}>1 — Bank</option>
                  <option value={2}>2 — Payment</option>
                  <option value={3}>3 — Merchant</option>
                </select>
              </div>
              <div className="flex-1 min-w-[120px]">
                <label className="block text-xs text-[#7C7E8C] mb-1">Note (optional)</label>
                <input
                  type="text"
                  placeholder="Description"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
                />
              </div>
              <button
                onClick={handleAddFilter}
                disabled={addSaving}
                className="px-4 py-2 bg-[#04B488] text-white rounded-lg text-sm font-medium hover:bg-[#03a07a] disabled:opacity-60 transition-colors"
              >
                {addSaving ? "Adding..." : "Add"}
              </button>
            </div>
            {addError && <p className="text-xs text-red-600 mt-2">{addError}</p>}
          </div>

          {/* Filters list */}
          {filtersLoading ? (
            <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-[#F8F8F8] rounded-lg animate-pulse" />)}</div>
          ) : (
            <div className="bg-white rounded-lg border border-[#E9E9EB]  overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-50 flex gap-4">
                <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide w-28">Type</span>
                <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide flex-1">Value</span>
                <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide w-20">Rank</span>
                <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide w-16">Active</span>
                <span className="w-14" />
              </div>
              <div className="divide-y divide-gray-50">
                {filters.map((f) => (
                  <div key={f.id} className={`px-5 py-2.5 flex items-center gap-4 ${!f.isActive ? "opacity-50" : ""}`}>
                    <span className="text-xs text-[#7C7E8C] w-28 truncate">{f.type.replace("_", " ")}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#44475B] font-mono truncate">{f.value}</p>
                      {f.note && <p className="text-xs text-[#A1A3AD] truncate">{f.note}</p>}
                    </div>
                    <span className="text-xs text-[#7C7E8C] w-20">{RANK_LABELS[f.sourceRank] ?? f.sourceRank}</span>
                    <button
                      onClick={() => toggleFilter(f.id, f.isActive)}
                      className={`w-16 text-xs px-2 py-1 rounded-full font-medium transition-colors ${
                        f.isActive ? "bg-green-100 text-[#04B488] hover:bg-green-200" : "bg-[#F8F8F8] text-[#7C7E8C] hover:bg-gray-200"
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
            <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="h-12 bg-[#F8F8F8] rounded-lg animate-pulse" />)}</div>
          ) : logs.length === 0 ? (
            <div className="bg-white rounded-lg border border-[#E9E9EB]  p-12 text-center">
              <p className="text-sm text-[#A1A3AD]">No reconciliation runs yet.</p>
              <p className="text-xs text-gray-300 mt-1">Use POST /api/gmail/reconcile with a statement email ID to reconcile.</p>
            </div>
          ) : (
            <div className="bg-white rounded-lg border border-[#E9E9EB]  overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-50 flex gap-4">
                <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide w-24">Date</span>
                <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide flex-1">Merchant</span>
                <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide w-24 text-right">Amount</span>
                <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide w-20">Status</span>
              </div>
              <div className="divide-y divide-gray-50">
                {logs.map((log) => (
                  <div key={log.id} className="px-5 py-2.5 flex items-center gap-4">
                    <span className="text-xs text-[#7C7E8C] w-24 whitespace-nowrap">
                      {new Date(log.statementDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#44475B] truncate">{log.statementMerchant}</p>
                      {log.mismatchDetails && (
                        <p className="text-xs text-amber-600 truncate">{log.mismatchDetails}</p>
                      )}
                    </div>
                    <span className="text-sm font-medium text-[#44475B] w-24 text-right">
                      ₹{log.statementAmount.toLocaleString("en-IN")}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium w-20 text-center ${STATUS_COLOURS[log.status] ?? "bg-[#F8F8F8] text-[#7C7E8C]"}`}>
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
          <h2 className="text-sm font-semibold text-[#44475B] mb-1">Statement Passwords</h2>
          <p className="text-sm text-[#7C7E8C] mb-6">
            Some bank statements arrive as password-protected PDFs. Enter the password for each sender so Financial Manager can read them.
          </p>

          {pwLoading && <p className="text-sm text-[#A1A3AD]">Loading…</p>}

          {passwords && (
            <>
              {passwords.pending.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-xs font-semibold text-orange-700 uppercase tracking-wide mb-3">
                    ⚠️ Encrypted statements found ({passwords.pending.length})
                  </h3>
                  <div className="flex flex-col gap-2">
                    {passwords.pending.map((domain) => (
                      <div key={domain} className="flex items-center gap-3 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                        <span className="flex-1 text-sm font-medium text-[#44475B] font-mono">{domain}</span>
                        <input
                          type="password"
                          placeholder="Enter password"
                          value={newPassword[domain] ?? ""}
                          onChange={(e) => setNewPassword((prev) => ({ ...prev, [domain]: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && void handleSavePassword(domain)}
                          className="border border-[#E9E9EB] rounded-lg px-3 py-1.5 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-[#04B488]"
                        />
                        <button
                          onClick={() => void handleSavePassword(domain)}
                          disabled={savingPw[domain] || !newPassword[domain]}
                          className="px-4 py-1.5 bg-[#04B488] text-white text-sm rounded-lg hover:bg-[#03a07a] disabled:opacity-50 transition-colors"
                        >
                          {savingPw[domain] ? "Saving…" : "Save"}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {passwords.stored.length > 0 && (
                <div className="bg-white rounded-lg border border-[#E9E9EB]  overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-50">
                    <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide">Stored passwords</span>
                  </div>
                  <div className="divide-y divide-gray-50">
                    {passwords.stored.map((entry) => (
                      <div key={entry.senderDomain} className="px-5 py-2.5 flex items-center gap-4">
                        <span className="flex-1 text-sm text-[#44475B] font-mono">{entry.senderDomain}</span>
                        <span className="text-xs text-[#A1A3AD]">
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
                <div className="bg-white rounded-lg border border-[#E9E9EB]  p-12 text-center">
                  <p className="text-sm text-[#A1A3AD]">No encrypted statements found yet.</p>
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
          <h2 className="text-sm font-semibold text-[#44475B] mb-1">Parse Logs</h2>
          <p className="text-sm text-[#7C7E8C] mb-4">
            Every email that entered the parsing pipeline. Use this to debug missing transactions. Logs are kept for 30 days.
          </p>

          <div className="flex flex-wrap gap-2 mb-4">
            <select
              value={parseOutcomeFilter}
              onChange={(e) => setParseOutcomeFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            >
              <option value="">All outcomes</option>
              <option value="inserted">Inserted</option>
              <option value="upgraded">Upgraded</option>
              <option value="skipped_duplicate">Skipped (duplicate)</option>
              <option value="not_transaction">Not a transaction</option>
              <option value="skipped_exclusion">Skipped (exclusion rule)</option>
              <option value="parse_failed">Parse failed</option>
              <option value="insufficient_data">Insufficient data</option>
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
              className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488] w-48"
            />
          </div>

          {parseLogsLoading ? (
            <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-[#F8F8F8] rounded-lg animate-pulse" />)}</div>
          ) : (
            <>
              <p className="text-xs text-[#A1A3AD] mb-2">{parseLogsTotal} entries</p>
              <div className="bg-white rounded-lg border border-[#E9E9EB]  overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-[#A1A3AD] uppercase tracking-wide border-b border-[#E9E9EB]">
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
                        <tr key={log.id} className="hover:bg-[#F8F8F8]">
                          <td className="px-5 py-2.5 text-xs text-[#7C7E8C] whitespace-nowrap">
                            {new Date(log.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                          </td>
                          <td className="px-5 py-2.5 text-sm text-[#44475B]">{log.senderDomain}</td>
                          <td className="px-5 py-2.5">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${outcomeColor(log.outcome)}`}>
                              {log.outcome}
                            </span>
                          </td>
                          <td className="px-5 py-2.5 text-sm text-[#44475B]">{log.parsedMerchant ?? "—"}</td>
                          <td className="px-5 py-2.5 text-sm text-right text-[#44475B]">
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
                              className="text-[#04B488] hover:underline text-xs"
                            >
                              View ↗
                            </a>
                          </td>
                          <td className="px-3 py-2.5">
                            {REPROCESSABLE.has(log.outcome) && (
                              <button
                                onClick={() => void handleReprocess(log.id)}
                                disabled={reprocessingId === log.id}
                                className="text-xs px-2 py-1 border border-[#E9E9EB] rounded-lg hover:bg-[#F8F8F8] disabled:opacity-50 transition-colors"
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
                    className="text-sm text-[#04B488] disabled:text-gray-300"
                  >
                    ← Previous
                  </button>
                  <span className="text-sm text-[#7C7E8C]">
                    Page {parseLogsPage} of {Math.ceil(parseLogsTotal / 50)}
                  </span>
                  <button
                    disabled={parseLogsPage >= Math.ceil(parseLogsTotal / 50)}
                    onClick={() => void loadParseLogs(parseLogsPage + 1)}
                    className="text-sm text-[#04B488] disabled:text-gray-300"
                  >
                    Next →
                  </button>
                </div>
              )}

              {parseLogs.length === 0 && (
                <div className="bg-white rounded-lg border border-[#E9E9EB]  p-12 text-center mt-2">
                  <p className="text-sm text-[#A1A3AD]">No parse logs found.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Gmail Sync */}
      <div className="mt-8 bg-white rounded-lg border border-[#E9E9EB]  p-5">
        <h3 className="text-sm font-semibold text-[#44475B] mb-2">Gmail Sync</h3>
        {gmailSyncedAt ? (
          <p className="text-sm text-[#7C7E8C] mb-3">
            Last synced:{" "}
            <span className="text-[#44475B] font-medium">
              {new Date(gmailSyncedAt).toLocaleString("en-IN", {
                day: "numeric", month: "short", year: "numeric",
                hour: "2-digit", minute: "2-digit",
              })}
            </span>
          </p>
        ) : (
          <p className="text-sm text-[#A1A3AD] mb-3">No sync completed yet.</p>
        )}
        <button
          onClick={handleSyncNow}
          disabled={syncing}
          className="px-4 py-2 text-sm bg-[#04B488] text-white rounded-lg hover:bg-[#03a07a] disabled:opacity-50 transition-colors"
        >
          {syncing ? "Starting…" : "Sync now"}
        </button>
        {syncMessage && <p className="text-xs text-[#7C7E8C] mt-2">{syncMessage}</p>}
      </div>

      {/* Gmail Query Keywords */}
      <div className="mt-8 bg-white rounded-lg border border-[#E9E9EB]  p-5">
        <h3 className="text-sm font-semibold text-[#44475B] mb-1">Gmail Query Keywords</h3>
        <p className="text-sm text-[#7C7E8C] mb-4">
          Keywords used to build the Gmail search query. Emails matching any keyword are fetched for processing. Changes take effect on the next sync.
        </p>

        {/* Add keyword form */}
        <div className="flex flex-wrap gap-2 items-end mb-4">
          <div>
            <label className="block text-xs text-[#7C7E8C] mb-1">Type</label>
            <select
              value={newKwType}
              onChange={(e) => setNewKwType(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            >
              <option value="from">From (sender)</option>
              <option value="subject">Subject keyword</option>
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-[#7C7E8C] mb-1">Value</label>
            <input
              type="text"
              placeholder="e.g. swiggy or ₹"
              value={newKwValue}
              onChange={(e) => setNewKwValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleAddKeyword()}
              className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            />
          </div>
          <button
            onClick={() => void handleAddKeyword()}
            disabled={addingKw || !newKwValue.trim()}
            className="px-4 py-2 bg-[#04B488] text-white rounded-lg text-sm font-medium hover:bg-[#03a07a] disabled:opacity-60 transition-colors"
          >
            {addingKw ? "Adding…" : "Add"}
          </button>
        </div>

        {gmailKeywordsLoading ? (
          <div className="flex flex-col gap-1.5">{[...Array(4)].map((_, i) => <div key={i} className="h-8 bg-[#F8F8F8] rounded-lg animate-pulse" />)}</div>
        ) : (
          <div className="divide-y divide-gray-50 border border-[#E9E9EB] rounded-lg overflow-hidden">
            {["from", "subject"].map((kwType) => {
              const group = gmailKeywords.filter((k) => k.type === kwType);
              if (group.length === 0) return null;
              return (
                <div key={kwType}>
                  <div className="px-4 py-2 bg-[#F8F8F8]">
                    <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide">{kwType === "from" ? "From (sender)" : "Subject keyword"}</span>
                  </div>
                  {group.map((kw) => (
                    <div key={kw.id} className={`px-4 py-2 flex items-center gap-3 ${!kw.isActive ? "opacity-50" : ""}`}>
                      <span className="flex-1 text-sm font-mono text-gray-800">{kw.value}</span>
                      {kw.isDefault && <span className="text-xs text-[#A1A3AD] bg-[#F8F8F8] px-2 py-0.5 rounded-full">default</span>}
                      <button
                        onClick={() => void toggleKeyword(kw.id, kw.isActive)}
                        className={`text-xs px-2 py-1 rounded-full font-medium transition-colors ${
                          kw.isActive ? "bg-green-100 text-[#04B488] hover:bg-green-200" : "bg-[#F8F8F8] text-[#7C7E8C] hover:bg-gray-200"
                        }`}
                      >
                        {kw.isActive ? "On" : "Off"}
                      </button>
                      <button
                        onClick={() => void deleteKeyword(kw.id)}
                        className="text-xs text-red-400 hover:text-red-600 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
            {gmailKeywords.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-[#A1A3AD]">No keywords configured.</div>
            )}
          </div>
        )}
      </div>

      {/* Exclusion Rules */}
      <div className="mt-8 bg-white rounded-lg border border-[#E9E9EB]  p-5">
        <h3 className="text-sm font-semibold text-[#44475B] mb-1">Exclusion Rules</h3>
        <p className="text-sm text-[#7C7E8C] mb-4">
          Senders or domains excluded from processing entirely (e.g. LinkedIn, job boards). Emails from excluded senders skip the LLM.
        </p>

        {/* Add exclusion form */}
        <div className="flex flex-wrap gap-2 items-end mb-4">
          <div>
            <label className="block text-xs text-[#7C7E8C] mb-1">Type</label>
            <select
              value={newExType}
              onChange={(e) => setNewExType(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            >
              <option value="sender_domain">Sender Domain</option>
              <option value="sender_email">Sender Email</option>
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-[#7C7E8C] mb-1">Value</label>
            <input
              type="text"
              placeholder="e.g. linkedin.com"
              value={newExValue}
              onChange={(e) => setNewExValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleAddExclusion()}
              className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            />
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="block text-xs text-[#7C7E8C] mb-1">Note (optional)</label>
            <input
              type="text"
              placeholder="e.g. Job alerts"
              value={newExNote}
              onChange={(e) => setNewExNote(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            />
          </div>
          <button
            onClick={() => void handleAddExclusion()}
            disabled={addingEx || !newExValue.trim()}
            className="px-4 py-2 bg-[#04B488] text-white rounded-lg text-sm font-medium hover:bg-[#03a07a] disabled:opacity-60 transition-colors"
          >
            {addingEx ? "Adding…" : "Add"}
          </button>
        </div>

        {exclusionLoading ? (
          <div className="flex flex-col gap-1.5">{[...Array(4)].map((_, i) => <div key={i} className="h-8 bg-[#F8F8F8] rounded-lg animate-pulse" />)}</div>
        ) : (
          <div className="divide-y divide-gray-50 border border-[#E9E9EB] rounded-lg overflow-hidden">
            {exclusionRules.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-[#A1A3AD]">No exclusion rules configured.</div>
            ) : exclusionRules.map((rule) => (
              <div key={rule.id} className={`px-4 py-2 flex items-center gap-3 ${!rule.isActive ? "opacity-50" : ""}`}>
                <span className="text-xs text-[#A1A3AD] w-28 shrink-0">{rule.type.replace("_", " ")}</span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-mono text-gray-800">{rule.value}</span>
                  {rule.note && <span className="text-xs text-[#A1A3AD] ml-2">{rule.note}</span>}
                </div>
                <button
                  onClick={() => void toggleExclusion(rule.id, rule.isActive)}
                  className={`text-xs px-2 py-1 rounded-full font-medium transition-colors ${
                    rule.isActive ? "bg-green-100 text-[#04B488] hover:bg-green-200" : "bg-[#F8F8F8] text-[#7C7E8C] hover:bg-gray-200"
                  }`}
                >
                  {rule.isActive ? "On" : "Off"}
                </button>
                <button
                  onClick={() => void deleteExclusion(rule.id)}
                  className="text-xs text-red-400 hover:text-red-600 transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sub-Category Taxonomy */}
      <div className="mt-8 bg-white rounded-lg border border-[#E9E9EB]  p-5">
        <h3 className="text-sm font-semibold text-[#44475B] mb-1">Sub-Category Taxonomy</h3>
        <p className="text-sm text-[#7C7E8C] mb-4">
          Sub-categories used by Gemini to classify transactions. System entries cannot be deleted.
        </p>

        {/* Add sub-category form */}
        <div className="flex flex-wrap gap-2 items-end mb-4">
          <div>
            <label className="block text-xs text-[#7C7E8C] mb-1">Category</label>
            <select
              value={newSubcatCategory}
              onChange={(e) => setNewSubcatCategory(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            >
              {VALID_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-[#7C7E8C] mb-1">Sub-category</label>
            <input
              type="text"
              placeholder="e.g. food delivery"
              value={newSubcatValue}
              onChange={(e) => setNewSubcatValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleAddSubcat()}
              className="w-full px-3 py-2 rounded-lg border border-[#E9E9EB] text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            />
          </div>
          <button
            onClick={() => void handleAddSubcat()}
            disabled={addingSubcat || !newSubcatValue.trim()}
            className="px-4 py-2 bg-[#04B488] text-white rounded-lg text-sm font-medium hover:bg-[#03a07a] disabled:opacity-60 transition-colors"
          >
            {addingSubcat ? "Adding…" : "Add"}
          </button>
        </div>

        {subcatLoading ? (
          <div className="flex flex-col gap-1.5">{[...Array(4)].map((_, i) => <div key={i} className="h-8 bg-[#F8F8F8] rounded-lg animate-pulse" />)}</div>
        ) : (
          <div className="divide-y divide-gray-50 border border-[#E9E9EB] rounded-lg overflow-hidden">
            {Object.keys(subcatByCategory).length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-[#A1A3AD]">No sub-categories configured.</div>
            ) : Object.entries(subcatByCategory).map(([category, entries]) => (
              <div key={category}>
                <div className="px-4 py-2 bg-[#F8F8F8]">
                  <span className="text-xs font-semibold text-[#A1A3AD] uppercase tracking-wide">{category}</span>
                </div>
                {entries.map((entry) => (
                  <div key={entry.id} className="px-4 py-2 flex items-center gap-3">
                    <span className="flex-1 text-sm text-gray-800">{entry.subCategory}</span>
                    {entry.addedBy === "system" ? (
                      <span className="text-xs text-[#A1A3AD] bg-[#F8F8F8] px-2 py-0.5 rounded-full">system</span>
                    ) : (
                      <button
                        onClick={() => void deleteSubcat(entry.id)}
                        className="text-xs text-red-400 hover:text-red-600 transition-colors"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Retro Re-sync */}
      <div className="mt-8 bg-white rounded-lg border border-[#E9E9EB]  p-5">
        <h3 className="text-sm font-semibold text-[#44475B] mb-1">Retro Re-sync</h3>
        <p className="text-sm text-[#7C7E8C] mb-3">
          Re-process historical emails with current filters and query keywords.
          Existing transactions are not duplicated.
        </p>
        <div className="flex items-center gap-3">
          <select
            value={retroPeriod}
            onChange={(e) => setRetroPeriod(e.target.value as RetroPeriod)}
            className="text-sm border border-[#E9E9EB] rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#04B488]"
          >
            <option value="1m">Last 1 month</option>
            <option value="3m">Last 3 months</option>
            <option value="6m">Last 6 months</option>
            <option value="12m">Last 12 months</option>
          </select>
          <button
            onClick={() => void handleRetroSync()}
            disabled={retroSyncing}
            className="px-4 py-2 text-sm bg-[#04B488] text-white rounded-lg hover:bg-[#03a07a] disabled:opacity-50 transition-colors"
          >
            {retroSyncing ? "Starting…" : "Start Retro Re-sync"}
          </button>
        </div>
        {retroMessage && <p className="text-xs text-[#7C7E8C] mt-2">{retroMessage}</p>}
      </div>

      {/* Demo Data */}
      <div className="mt-8 bg-white rounded-lg border border-[#E9E9EB]  p-5">
        <h3 className="text-sm font-semibold text-[#44475B] mb-2">Demo Data</h3>
        <p className="text-sm text-[#7C7E8C] mb-3">
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
      <div className="mt-4 bg-white rounded-lg border border-red-100  p-5">
        <h3 className="text-sm font-semibold text-[#ED5533] mb-2">Danger Zone</h3>
        <p className="text-sm text-[#7C7E8C] mb-3">
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
        <div className="mt-8 p-4 border border-dashed border-[#E9E9EB] rounded-lg">
          <p className="text-xs text-[#7C7E8C] font-mono mb-2">DEV ONLY</p>
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

      {/* ── Categories Tab ── */}
      {tab === "categories" && (
        <div>
          <h2 className="text-lg font-semibold text-[#44475B] mb-1">Categories</h2>
          <p className="text-sm text-[#7C7E8C] mb-4">
            Categories are shared across all users. Default categories cannot be removed.
          </p>

          {/* Add new category form */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-4">
            <p className="text-sm font-semibold text-[#44475B] mb-3">Add new category</p>
            <input
              type="text"
              placeholder="Category name (e.g. Fitness, Petrol)"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              className="mb-3 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#04B488]"
            />
            <p className="text-xs font-semibold text-[#7C7E8C] uppercase tracking-wide mb-2">Choose icon</p>
            <IconPicker selected={newCatIcon} onSelect={setNewCatIcon} />
            {newCatIcon && (
              <div className="flex items-center gap-2 mt-2">
                <CategoryIcon name={newCatIcon} slug="preview" label={newCatName || "New"} size={20} className="text-[#44475B]" />
                <span className="text-xs text-[#7C7E8C]">
                  Preview ·{" "}
                  <button onClick={() => setNewCatIcon("")} className="text-[#ed5533] hover:underline">Clear</button>
                </span>
              </div>
            )}
            {catAddError && <p className="text-xs text-red-500 mt-2">{catAddError}</p>}
            <button
              onClick={handleAddCat}
              disabled={!newCatName.trim() || catAddSaving}
              className="mt-3 px-5 py-2 bg-[#04B488] text-white text-sm font-medium rounded-xl hover:bg-[#03a07a] disabled:opacity-50 transition-colors"
            >
              {catAddSaving ? "Saving…" : "Add category"}
            </button>
          </div>

          {/* Category list */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            {catLoading ? (
              <div className="p-4 flex flex-col gap-2">
                {[...Array(6)].map((_, i) => <div key={i} className="h-10 bg-gray-50 rounded-xl animate-pulse" />)}
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-50">
                    <th className="text-left text-xs font-semibold text-gray-400 px-5 py-3 uppercase tracking-wide">Icon</th>
                    <th className="text-left text-xs font-semibold text-gray-400 px-5 py-3 uppercase tracking-wide">Name</th>
                    <th className="text-left text-xs font-semibold text-gray-400 px-5 py-3 uppercase tracking-wide">Slug</th>
                    <th className="text-left text-xs font-semibold text-gray-400 px-5 py-3 uppercase tracking-wide">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {catList.map((cat) => (
                    <tr key={cat.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-5 py-3">
                        <CategoryIcon name={cat.icon} slug={cat.slug} label={cat.name} size={20} className="text-[#44475B]" />
                      </td>
                      <td className="px-5 py-3 text-sm font-medium text-[#44475B]">{cat.name}</td>
                      <td className="px-5 py-3 text-xs text-[#A1A3AD] font-mono">{cat.slug}</td>
                      <td className="px-5 py-3">
                        {cat.isDefault ? (
                          <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full">Default</span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 bg-[#E9FAF3] text-[#04B488] rounded-full">Custom</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
