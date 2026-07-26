"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ScanStatus = {
  scanRunId: string;
  status: string;
  discoveryComplete: boolean;
  counters: {
    totalDiscovered: number;
    fetchedIncludedCount: number;
    fetchedExcludedCount: number;
    permanentlyFailedCount: number;
  };
  progress: { processedCount: number; percentage: number | null };
  cacheMatches: boolean;
  schedulingPending: boolean;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

type EmailItem = {
  id: string;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  receivedAt: string | null;
  lastFetchStatus: string;
  currentManualClassification: string;
};

type FilterRule = {
  rule_id: string;
  type: "sender_domain" | "sender_email" | "subject_keyword";
  pattern: string;
};

type InventoryFilter = {
  id: string;
  name: string;
  isActive: boolean;
  currentVersion: {
    version: number;
    gmailQuery: string;
    includeRulesJson: FilterRule[];
    excludeRulesJson: FilterRule[];
  } | null;
};

const TERMINAL = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLED",
]);

export function EmailInventoryPanel() {
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [items, setItems] = useState<EmailItem[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [filters, setFilters] = useState<InventoryFilter[]>([]);
  const [gmailQuery, setGmailQuery] = useState(
    "in:inbox -category:promotions -category:social -category:forums",
  );
  const [includeRules, setIncludeRules] = useState("[]");
  const [excludeRules, setExcludeRules] = useState("[]");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<number | null>(null);

  const refreshInventory = useCallback(async () => {
    const [listResponse, statsResponse] = await Promise.all([
      fetch("/api/gmail/email/list?limit=50"),
      fetch("/api/gmail/email/stats"),
    ]);
    if (listResponse.ok) {
      const data = (await listResponse.json()) as { items: EmailItem[] };
      setItems(data.items ?? []);
    }
    if (statsResponse.ok) {
      const data = (await statsResponse.json()) as {
        classification: Record<string, number>;
      };
      setStats(data.classification ?? {});
    }
  }, []);

  const refreshFilters = useCallback(async () => {
    const response = await fetch("/api/email-filters");
    if (!response.ok) return;
    const data = (await response.json()) as { filters: InventoryFilter[] };
    const next = data.filters ?? [];
    setFilters(next);
    const current = next.find((filter) => filter.isActive)?.currentVersion;
    if (current) {
      setGmailQuery(current.gmailQuery);
      setIncludeRules(JSON.stringify(current.includeRulesJson, null, 2));
      setExcludeRules(JSON.stringify(current.excludeRulesJson, null, 2));
    }
  }, []);

  const refreshScan = useCallback(
    async (scanRunId: string) => {
      const response = await fetch(`/api/gmail/scan/${scanRunId}`);
      if (!response.ok) return;
      const next = (await response.json()) as ScanStatus;
      setScan(next);
      if (TERMINAL.has(next.status)) await refreshInventory();
    },
    [refreshInventory],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void Promise.all([refreshInventory(), refreshFilters()]);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [refreshFilters, refreshInventory]);

  useEffect(() => {
    if (!scan || TERMINAL.has(scan.status) || scan.status === "PAUSED") return;
    pollRef.current = window.setInterval(
      () => void refreshScan(scan.scanRunId),
      2_000,
    );
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [scan, refreshScan]);

  const startScan = async () => {
    if (busy) return;
    setBusy("start");
    setError("");
    try {
      const response = await fetch("/api/gmail/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period: "6m",
          clientRequestId: crypto.randomUUID(),
        }),
      });
      const data = (await response.json()) as {
        scanRunId?: string;
        error?: string;
      };
      if (!response.ok || !data.scanRunId) {
        throw new Error(data.error ?? "Unable to start scan");
      }
      await refreshScan(data.scanRunId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to start scan");
    } finally {
      setBusy(null);
    }
  };

  const control = async (action: "pause" | "resume" | "retry" | "cancel") => {
    if (!scan || busy) return;
    setBusy(action);
    setError("");
    try {
      const response = await fetch(
        `/api/gmail/scan/${scan.scanRunId}/${action}`,
        { method: "POST" },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Unable to ${action} scan`);
      await refreshScan(scan.scanRunId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to ${action} scan`);
    } finally {
      setBusy(null);
    }
  };

  const classify = async (
    sourceId: string,
    classification: "FINANCIAL" | "NON_FINANCIAL" | "UNCERTAIN",
  ) => {
    if (busy) return;
    setBusy(sourceId);
    setError("");
    try {
      const response = await fetch(`/api/gmail/email/${sourceId}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classification }),
      });
      if (!response.ok) throw new Error("Unable to save classification");
      await refreshInventory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to classify email");
    } finally {
      setBusy(null);
    }
  };

  const saveFilter = async () => {
    if (busy) return;
    setBusy("filter");
    setError("");
    try {
      const body = {
        gmailQuery,
        includeRules: JSON.parse(includeRules) as unknown,
        excludeRules: JSON.parse(excludeRules) as unknown,
      };
      const active = filters.find((filter) => filter.isActive);
      const response = await fetch(
        active ? `/api/email-filters/${active.id}/versions` : "/api/email-filters",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            active ? body : { ...body, name: "Default Gmail inventory" },
          ),
        },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to save filter");
      await refreshFilters();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invalid filter rules");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[#E9E9EB] bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#44475B]">
              Gmail email inventory
            </h2>
            <p className="mt-1 text-xs text-[#7C7E8C]">
              Scans six months of Gmail metadata. Message bodies are processed
              transiently and are not stored. This scan does not create
              transactions or call an LLM.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void startScan()}
            disabled={busy !== null || (!!scan && !TERMINAL.has(scan.status))}
            className="rounded-lg bg-[#04B488] px-4 py-2 text-sm font-medium text-white hover:bg-[#03a07a] disabled:opacity-50"
          >
            {busy === "start" ? "Starting…" : "Start six-month scan"}
          </button>
        </div>

        {scan && (
          <div className="mt-4 rounded-lg bg-[#F8F8F8] p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-[#44475B]">{scan.status}</span>
              <span className="text-[#7C7E8C]">
                {scan.progress.processedCount}/{scan.counters.totalDiscovered}
                {scan.progress.percentage !== null
                  ? ` (${scan.progress.percentage}%)`
                  : ""}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#E9E9EB]">
              <div
                className="h-full bg-[#04B488] transition-all"
                style={{ width: `${scan.progress.percentage ?? 0}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-[#7C7E8C]">
              Included {scan.counters.fetchedIncludedCount} · Excluded{" "}
              {scan.counters.fetchedExcludedCount} · Failed{" "}
              {scan.counters.permanentlyFailedCount} · Counters{" "}
              {scan.cacheMatches ? "reconciled" : "being reconciled"}
            </p>
            {scan.lastErrorCode && (
              <p className="mt-2 text-xs text-red-700">
                {scan.lastErrorCode}:{" "}
                {scan.lastErrorMessage ?? "Scan processing failed"}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {!TERMINAL.has(scan.status) && scan.status !== "PAUSED" && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void control("pause")}
                  className="rounded border border-[#D9DBE3] px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Pause
                </button>
              )}
              {scan.status === "PAUSED" && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void control("resume")}
                  className="rounded border border-[#D9DBE3] px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Resume
                </button>
              )}
              {(scan.schedulingPending ||
                ["CREATED", "RETRY_WAIT", "FAILED"].includes(scan.status)) && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void control("retry")}
                  className="rounded border border-[#D9DBE3] px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Retry
                </button>
              )}
              {!TERMINAL.has(scan.status) && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void control("cancel")}
                  className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-700 disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </section>

      <section className="rounded-lg border border-[#E9E9EB] bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#44475B]">
              Versioned email filter
            </h2>
            <p className="mt-1 text-xs text-[#7C7E8C]">
              Each save creates an immutable version. Active scans continue
              using their original snapshot.
            </p>
          </div>
          <span className="text-xs text-[#7C7E8C]">
            Version{" "}
            {filters.find((filter) => filter.isActive)?.currentVersion?.version ??
              "not created"}
          </span>
        </div>
        <label className="mt-4 block text-xs font-medium text-[#7C7E8C]">
          Gmail query
        </label>
        <input
          value={gmailQuery}
          onChange={(event) => setGmailQuery(event.target.value)}
          className="mt-1 w-full rounded-lg border border-[#D9DBE3] px-3 py-2 text-sm"
        />
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="text-xs font-medium text-[#7C7E8C]">
            Include rules (JSON array)
            <textarea
              value={includeRules}
              onChange={(event) => setIncludeRules(event.target.value)}
              rows={6}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-[#D9DBE3] px-3 py-2 font-mono text-xs"
            />
          </label>
          <label className="text-xs font-medium text-[#7C7E8C]">
            Exclude rules (JSON array)
            <textarea
              value={excludeRules}
              onChange={(event) => setExcludeRules(event.target.value)}
              rows={6}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-[#D9DBE3] px-3 py-2 font-mono text-xs"
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-[#7C7E8C]">
          Rule fields: rule_id, type (sender_domain, sender_email, or
          subject_keyword), and pattern.
        </p>
        <button
          type="button"
          onClick={() => void saveFilter()}
          disabled={busy !== null}
          className="mt-3 rounded-lg border border-[#04B488] px-4 py-2 text-sm font-medium text-[#04B488] disabled:opacity-50"
        >
          {busy === "filter" ? "Saving…" : "Save new filter version"}
        </button>
      </section>

      <section className="rounded-lg border border-[#E9E9EB] bg-white">
        <div className="border-b border-[#E9E9EB] px-5 py-4">
          <h2 className="text-sm font-semibold text-[#44475B]">
            Manual review
          </h2>
          <p className="mt-1 text-xs text-[#7C7E8C]">
            Unreviewed {stats.UNREVIEWED ?? 0} · Financial{" "}
            {stats.FINANCIAL ?? 0} · Non-financial{" "}
            {stats.NON_FINANCIAL ?? 0} · Uncertain {stats.UNCERTAIN ?? 0}
          </p>
        </div>
        {items.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-[#7C7E8C]">
            No inventory metadata yet. Start a scan to discover messages.
          </p>
        ) : (
          <div className="divide-y divide-[#F0F0F2]">
            {items.map((item) => (
              <div key={item.id} className="px-5 py-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[#44475B]">
                      {item.subject ?? "(No subject)"}
                    </p>
                    <p className="truncate text-xs text-[#7C7E8C]">
                      {item.senderName ?? item.senderEmail ?? "Unknown sender"}
                      {item.receivedAt
                        ? ` · ${new Date(item.receivedAt).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>
                  <span className="text-xs text-[#7C7E8C]">
                    {item.currentManualClassification.replace("_", " ")}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(
                    [
                      ["FINANCIAL", "Financial"],
                      ["NON_FINANCIAL", "Not financial"],
                      ["UNCERTAIN", "Uncertain"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      disabled={busy !== null}
                      onClick={() => void classify(item.id, value)}
                      className="rounded border border-[#D9DBE3] px-2.5 py-1 text-xs hover:border-[#04B488] disabled:opacity-50"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
