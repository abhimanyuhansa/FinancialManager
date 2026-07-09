# Plan 9g: Parse Logs Observability UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Parse Logs" tab to Settings that shows every email that entered the pipeline, filterable by outcome/domain/date; add per-row Reprocess action for failed/skipped items.

**Architecture:** Two new API routes (paginated GET, POST reprocess) and one new Settings tab. The reprocess action re-fetches the original Gmail message and re-runs it through the current pipeline (respects current MerchantRules and EmailFilters).

**Prerequisite:** Plans 9a (ParseLog schema), 9b (ParseLog writes during sync), 9c (cron) complete.

**Tech Stack:** Next.js 16, React, Prisma 7, Gmail API

---

## File Map

| File | Action |
|------|--------|
| `src/app/api/settings/parse-logs/route.ts` | New — GET paginated ParseLogs |
| `src/app/api/settings/parse-logs/[id]/reprocess/route.ts` | New — POST reprocess one ParseLog entry |
| `src/app/(app)/settings/page.tsx` | Add Parse Logs tab |

---

## Task 1: Create the ParseLogs GET endpoint

**Files:**
- Create: `src/app/api/settings/parse-logs/route.ts`

- [ ] **Step 1: Write the route**

Create `src/app/api/settings/parse-logs/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const outcome = searchParams.get("outcome") ?? "";
  const domain = searchParams.get("domain") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  const where: Parameters<typeof prisma.parseLog.findMany>[0]["where"] = { userId };
  if (outcome) where.outcome = outcome;
  if (domain) where.senderDomain = { contains: domain, mode: "insensitive" };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      where.createdAt.lte = toDate;
    }
  }

  const [total, logs] = await Promise.all([
    prisma.parseLog.count({ where }),
    prisma.parseLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        gmailMsgId: true,
        senderDomain: true,
        emailDate: true,
        outcome: true,
        geminiConfidence: true,
        parsedMerchant: true,
        parsedAmount: true,
        wasTruncated: true,
        bodyLengthRaw: true,
        bodyLengthSent: true,
        transactionId: true,
        errorDetail: true,
        createdAt: true,
      },
    }),
  ]);

  return NextResponse.json({ logs, total, page, pageSize: PAGE_SIZE });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/settings/parse-logs/route.ts
git commit -m "feat(api): add GET /api/settings/parse-logs with pagination and filters"
```

---

## Task 2: Create the Reprocess endpoint

**Files:**
- Create: `src/app/api/settings/parse-logs/[id]/reprocess/route.ts`

- [ ] **Step 1: Write the reprocess route**

Create `src/app/api/settings/parse-logs/[id]/reprocess/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { parseEmailBatch } from "@/lib/gemini";
import { upsertTransaction } from "@/lib/dedup";
import { matchesEmailFilter } from "@/lib/emailFilter";

type RouteContext = { params: { id: string } };

const BODY_LIMIT = 1500;

async function fetchFullMessage(
  accessToken: string,
  msgId: string
): Promise<{ body: string; senderName: string; senderDomain: string; receivedDate: string } | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;

  const msg = await res.json() as {
    internalDate?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    };
  };

  const headers = msg.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
  const senderRaw = get("From");
  const senderName = senderRaw.replace(/<[^>]+>/, "").trim() || senderRaw;
  const emailMatch = senderRaw.match(/<([^>]+)>/);
  const senderEmail = emailMatch ? emailMatch[1] : senderRaw;
  const senderDomain = senderEmail.includes("@") ? senderEmail.split("@")[1] : senderEmail;
  const receivedDate = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  let body = "";
  const parts = msg.payload?.parts ?? [];
  const plainPart = parts.find((p) => p.mimeType === "text/plain");
  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  const rawData = plainPart?.body?.data ?? htmlPart?.body?.data ?? msg.payload?.body?.data ?? "";
  if (rawData) {
    const decoded = Buffer.from(rawData, "base64url").toString("utf-8");
    body = decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return { body, senderName, senderDomain, receivedDate };
}

export async function POST(_req: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const apiKey = process.env.GEMINI_API_KEY ?? "";

  const log = await prisma.parseLog.findUnique({
    where: { id: params.id },
    select: { id: true, userId: true, gmailMsgId: true, syncJobId: true, senderDomain: true },
  });

  if (!log || log.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Cannot reprocess duplicates — those are permanent
  // (outcome === "skipped_duplicate" should not show Reprocess button in UI,
  //  but guard here as well)

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please reconnect Gmail" }, { status: 400 });
  }

  const msg = await fetchFullMessage(accessToken, log.gmailMsgId);
  if (!msg) {
    return NextResponse.json({ error: "Could not fetch Gmail message" }, { status: 400 });
  }

  // Re-check filter
  const isActive = await matchesEmailFilter(msg.senderDomain, msg.senderName);
  if (!isActive) {
    await prisma.parseLog.update({
      where: { id: log.id },
      data: { outcome: "skipped_filter" },
    });
    return NextResponse.json({ outcome: "skipped_filter" });
  }

  const results = await parseEmailBatch([
    { emailIndex: 0, body: msg.body, senderName: msg.senderName, fallbackDate: msg.receivedDate },
  ], apiKey);

  const result = results[0];

  if (result.outcome !== "parsed") {
    await prisma.parseLog.update({
      where: { id: log.id },
      data: {
        outcome: result.outcome,
        bodyLengthRaw: result.bodyLengthRaw,
        bodyLengthSent: result.bodyLengthSent,
        wasTruncated: result.wasTruncated,
      },
    });
    return NextResponse.json({ outcome: result.outcome });
  }

  let category = result.category!;
  const merchantKey = result.merchant!.toLowerCase().trim();
  const rule = await prisma.merchantRule.findUnique({
    where: { userId_merchantName: { userId, merchantName: merchantKey } },
  });
  if (rule) category = rule.category;

  const upsertResult = await upsertTransaction({
    userId,
    gmailMsgId: log.gmailMsgId,
    date: new Date(result.date!),
    merchant: result.merchant!,
    amount: result.amount!,
    type: result.type!,
    currency: result.currency!,
    category,
    source: "gmail",
    sourceRank: 3,
    confidence: result.confidence,
    needsReview: result.needsReview,
  });

  const finalOutcome = upsertResult.action === "inserted" ? "inserted"
    : upsertResult.action === "upgraded" ? "upgraded"
    : "skipped_duplicate";

  await prisma.parseLog.update({
    where: { id: log.id },
    data: {
      outcome: finalOutcome,
      geminiConfidence: result.confidence,
      parsedMerchant: result.merchant,
      parsedAmount: result.amount,
      transactionId: upsertResult.id ?? undefined,
      bodyLengthRaw: result.bodyLengthRaw,
      bodyLengthSent: result.bodyLengthSent,
      wasTruncated: result.wasTruncated,
    },
  });

  return NextResponse.json({ outcome: finalOutcome, transactionId: upsertResult.id });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/settings/parse-logs/[id]/reprocess/route.ts
git commit -m "feat(api): add POST /api/settings/parse-logs/[id]/reprocess"
```

---

## Task 3: Add Parse Logs Settings Tab

**Files:**
- Modify: `src/app/(app)/settings/page.tsx`

- [ ] **Step 1: Add state and fetch logic**

Add to the settings component:

```typescript
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
  errorDetail: string | null;
  createdAt: string;
};

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

useEffect(() => {
  if (activeTab === "parse-logs") {
    loadParseLogs(1);
  }
}, [activeTab, parseOutcomeFilter, parseDomainFilter]);

const handleReprocess = async (id: string) => {
  setReprocessingId(id);
  const res = await fetch(`/api/settings/parse-logs/${id}/reprocess`, { method: "POST" });
  const data = await res.json() as { outcome?: string; error?: string };
  setReprocessingId(null);
  if (data.error) {
    alert(`Reprocess failed: ${data.error}`);
  } else {
    // Refresh the log entry
    await loadParseLogs(parseLogsPage);
  }
};
```

- [ ] **Step 2: Add outcome color helper**

```typescript
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
```

- [ ] **Step 3: Add Parse Logs tab panel JSX**

```typescript
{activeTab === "parse-logs" && (
  <div>
    <h2 className="text-lg font-semibold text-gray-900 mb-1">Parse Logs</h2>
    <p className="text-sm text-gray-500 mb-4">
      Every email that entered the parsing pipeline. Use this to debug missing transactions.
      Logs are kept for 30 days.
    </p>

    {/* Filters */}
    <div className="flex gap-3 mb-4">
      <select
        value={parseOutcomeFilter}
        onChange={(e) => setParseOutcomeFilter(e.target.value)}
        className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
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
        className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-48"
      />
    </div>

    {parseLogsLoading ? (
      <p className="text-sm text-gray-400">Loading…</p>
    ) : (
      <>
        <div className="text-xs text-gray-400 mb-2">{parseLogsTotal} entries</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase border-b border-gray-200">
                <th className="text-left py-2 pr-4">Date</th>
                <th className="text-left py-2 pr-4">Domain</th>
                <th className="text-left py-2 pr-4">Outcome</th>
                <th className="text-left py-2 pr-4">Merchant</th>
                <th className="text-right py-2 pr-4">Amount</th>
                <th className="text-center py-2 pr-4">Trunc?</th>
                <th className="text-left py-2 pr-4">Email</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {parseLogs.map((log) => (
                <tr key={log.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleDateString("en-IN", {
                      day: "numeric", month: "short",
                    })}
                  </td>
                  <td className="py-2 pr-4 text-gray-700">{log.senderDomain}</td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${outcomeColor(log.outcome)}`}>
                      {log.outcome}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-700">{log.parsedMerchant ?? "—"}</td>
                  <td className="py-2 pr-4 text-right text-gray-700">
                    {log.parsedAmount != null ? `₹${log.parsedAmount}` : "—"}
                  </td>
                  <td className="py-2 pr-4 text-center">
                    {log.wasTruncated ? (
                      <span title={`${log.bodyLengthRaw} → ${log.bodyLengthSent} chars`} className="text-orange-500 cursor-help">
                        ⚠️
                      </span>
                    ) : "—"}
                  </td>
                  <td className="py-2 pr-4">
                    <a
                      href={`https://mail.google.com/mail/u/0/#all/${log.gmailMsgId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#5b7cfa] hover:underline text-xs"
                    >
                      View ↗
                    </a>
                  </td>
                  <td className="py-2">
                    {REPROCESSABLE.has(log.outcome) && (
                      <button
                        onClick={() => handleReprocess(log.id)}
                        disabled={reprocessingId === log.id}
                        className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50"
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

        {/* Pagination */}
        {parseLogsTotal > 50 && (
          <div className="flex justify-between items-center mt-4">
            <button
              disabled={parseLogsPage <= 1}
              onClick={() => loadParseLogs(parseLogsPage - 1)}
              className="text-sm text-[#5b7cfa] disabled:text-gray-300"
            >
              ← Previous
            </button>
            <span className="text-sm text-gray-500">
              Page {parseLogsPage} of {Math.ceil(parseLogsTotal / 50)}
            </span>
            <button
              disabled={parseLogsPage >= Math.ceil(parseLogsTotal / 50)}
              onClick={() => loadParseLogs(parseLogsPage + 1)}
              className="text-sm text-[#5b7cfa] disabled:text-gray-300"
            >
              Next →
            </button>
          </div>
        )}
      </>
    )}
  </div>
)}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/page.tsx" src/app/api/settings/parse-logs/
git commit -m "feat(settings): add Parse Logs observability tab with reprocess action"
```

---

## Self-Check

- [x] GET /api/settings/parse-logs: paginated 50/page, filterable by outcome, domain, date
- [x] All ParseLog fields returned: date, domain, outcome, merchant, amount, truncated, email link
- [x] POST /api/settings/parse-logs/[id]/reprocess: re-fetches Gmail message, re-runs current pipeline (respects updated MerchantRules + EmailFilters), updates ParseLog outcome
- [x] `skipped_duplicate` rows do NOT show Reprocess button (outcome cannot be changed)
- [x] Reprocess button disabled while processing (loading state)
- [x] Outcome color-coded: green for inserted, blue for upgraded, orange for skipped, red for failed
- [x] Truncation warning (⚠️) with tooltip showing raw vs sent lengths
- [x] Gmail link opens source email in new tab
- [x] Pagination controls for logs > 50 entries
- [x] Filters trigger re-fetch (not client-side filtering — fetches from API)
