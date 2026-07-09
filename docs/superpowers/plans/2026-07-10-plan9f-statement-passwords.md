# Plan 9f: Statement Passwords UI + PDF Support

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PDF attachment parsing to the Gmail fetch flow; handle password-protected PDFs by flagging them and storing per-domain passwords; add a "Statement Passwords" settings tab.

**Architecture:** `src/lib/gmail.ts` gains PDF attachment extraction. The chunk/advance routes detect encrypted PDFs and log them. Three new API routes manage statement passwords (GET, POST, DELETE). Settings page gets a new "Statement Passwords" tab. `src/lib/crypto.ts` (from Plan 9a) is used for AES-256-GCM encryption.

**Prerequisite:** Plans 9a (schema + crypto) and 9b (ParseLog instrumentation) complete.

**Tech Stack:** Next.js 16, Prisma 7, `pdf-parse` npm package, Node.js `crypto` module (AES-256-GCM)

---

## File Map

| File | Action |
|------|--------|
| `src/lib/gmail.ts` | Add PDF attachment fetching + `pdf-parse` extraction |
| `src/app/api/gmail/sync/chunk/route.ts` | Handle `skipped_pdf_encrypted` and `skipped_pdf_failed` outcomes |
| `src/app/api/gmail/sync/advance/route.ts` | Same PDF handling (these two share the same `fetchFullMessage` logic — consider extracting to a shared lib) |
| `src/app/api/settings/statement-passwords/route.ts` | New — GET list + POST upsert |
| `src/app/api/settings/statement-passwords/[domain]/route.ts` | New — DELETE by domain |
| `src/app/(app)/settings/page.tsx` | Add Statement Passwords tab |

---

## Task 1: Install pdf-parse

**Files:**
- `package.json` (modified by npm install)

- [ ] **Step 1: Install the dependency**

```bash
npm install pdf-parse
npm install --save-dev @types/pdf-parse
```

Expected: `added X packages` with no errors.

- [ ] **Step 2: Verify installation**

```bash
node -e "require('pdf-parse'); console.log('pdf-parse ok')"
```

Expected: `pdf-parse ok`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install pdf-parse for statement attachment parsing"
```

---

## Task 2: Add PDF extraction to gmail.ts fetchFullMessage

**Files:**
- Modify: `src/lib/gmail.ts`

- [ ] **Step 1: Read the current gmail.ts**

Read `src/lib/gmail.ts` in full to understand the current structure.

- [ ] **Step 2: Add PDF extraction to fetchFullMessage (or equivalent fetch function)**

The goal is: after extracting the text body, also scan `payload.parts` for `mimeType: "application/pdf"`. For each PDF:

1. Fetch the attachment bytes via Gmail attachments API
2. Attempt `pdfParse(buffer)` — if successful, append extracted text (up to 3000 additional chars) to body
3. If decrypt fails with password error: return a special result indicating `skipped_pdf_encrypted`
4. If other error: return `skipped_pdf_failed`

Export a new type and function from `gmail.ts`:

```typescript
import pdfParse from "pdf-parse";

export type PdfResult =
  | { status: "ok"; text: string }
  | { status: "encrypted" }
  | { status: "failed"; error: string };

export async function fetchPdfAttachment(
  accessToken: string,
  msgId: string,
  attachmentId: string,
  password?: string
): Promise<PdfResult> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` };

  const data = await res.json() as { data?: string };
  if (!data.data) return { status: "failed", error: "Empty attachment" };

  const buffer = Buffer.from(data.data, "base64url");

  try {
    const options = password ? { password } : {};
    const result = await pdfParse(buffer, options);
    return { status: "ok", text: result.text.slice(0, 3000) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("password") || msg.toLowerCase().includes("encrypted")) {
      return { status: "encrypted" };
    }
    return { status: "failed", error: msg };
  }
}
```

**Update `fetchFullMessage`** (or the equivalent in your codebase — read it first) to also scan for PDF parts and append extracted text to the body. The function's return type should also carry the PDF outcome:

```typescript
export type FetchedMessage = {
  body: string;
  senderName: string;
  senderDomain: string;
  receivedDate: string;
  pdfOutcome?: "ok" | "encrypted" | "failed" | null;
  hasPdfAttachment: boolean;
};

// Inside fetchFullMessage, after extracting text body:
let pdfOutcome: FetchedMessage["pdfOutcome"] = null;
let hasPdfAttachment = false;

const pdfParts = (msg.payload?.parts ?? []).filter(
  (p) => p.mimeType === "application/pdf" && p.body?.attachmentId
);

if (pdfParts.length > 0) {
  hasPdfAttachment = true;
  // Try the first PDF attachment
  const part = pdfParts[0];
  const pdfResult = await fetchPdfAttachment(accessToken, msgId, part.body!.attachmentId!);
  if (pdfResult.status === "ok") {
    body = (body + "\n\n" + pdfResult.text).trim();
    pdfOutcome = "ok";
  } else {
    pdfOutcome = pdfResult.status; // "encrypted" or "failed"
  }
}

return { body, senderName, senderDomain, receivedDate, pdfOutcome, hasPdfAttachment };
```

- [ ] **Step 3: Update chunk/route.ts to handle PDF outcomes**

In `src/app/api/gmail/sync/chunk/route.ts`, after calling `fetchFullMessage`, check for PDF outcomes:

```typescript
const msg = await fetchFullMessage(accessToken, msgId);
if (!msg) continue;

// Handle PDF-only failures before filter check
if (msg.hasPdfAttachment && msg.pdfOutcome === "encrypted") {
  // Check if we have a stored password for this domain
  const storedPw = await prisma.statementPassword.findUnique({
    where: { userId_senderDomain: { userId, senderDomain: msg.senderDomain } },
  });
  if (storedPw) {
    // Retry with stored password — need the attachmentId again
    // Simplest: re-fetch the message and try with password
    // For now: skip encrypted PDFs even with a stored password (password retry is handled by reprocess)
    // TODO: implement password retry in reprocess flow
  }
  // No password stored — log and count
  await prisma.parseLog.create({
    data: {
      userId,
      syncJobId: jobId,
      gmailMsgId: msgId,
      senderDomain: msg.senderDomain,
      bodyLengthRaw: 0,
      bodyLengthSent: 0,
      wasTruncated: false,
      batchSize: 1,
      outcome: "skipped_pdf_encrypted",
    },
  });
  encryptedBlockedCount++;
  continue;
}

if (msg.hasPdfAttachment && msg.pdfOutcome === "failed") {
  await prisma.parseLog.create({
    data: {
      userId,
      syncJobId: jobId,
      gmailMsgId: msgId,
      senderDomain: msg.senderDomain,
      bodyLengthRaw: 0,
      bodyLengthSent: 0,
      wasTruncated: false,
      batchSize: 1,
      outcome: "skipped_pdf_failed",
    },
  });
  continue;
}
```

Make the same change in `src/app/api/gmail/sync/advance/route.ts` in the `advanceJob` function.

- [ ] **Step 4: Commit**

```bash
git add src/lib/gmail.ts src/app/api/gmail/sync/chunk/route.ts src/app/api/gmail/sync/advance/route.ts
git commit -m "feat(pdf): add PDF attachment parsing with encrypted-PDF detection"
```

---

## Task 3: Statement Password API Routes

**Files:**
- Create: `src/app/api/settings/statement-passwords/route.ts`
- Create: `src/app/api/settings/statement-passwords/[domain]/route.ts`

- [ ] **Step 1: Verify directory exists**

```bash
ls src/app/api/settings/
```

If no `statement-passwords/` dir exists, it will be created when you write the files.

- [ ] **Step 2: Write GET + POST route**

Create `src/app/api/settings/statement-passwords/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // Stored passwords
  const stored = await prisma.statementPassword.findMany({
    where: { userId },
    select: { senderDomain: true, createdAt: true, updatedAt: true },
    orderBy: { senderDomain: "asc" },
  });

  // Domains that have encrypted-PDF parse logs but no stored password
  const encryptedLogs = await prisma.parseLog.findMany({
    where: { userId, outcome: "skipped_pdf_encrypted" },
    select: { senderDomain: true },
    distinct: ["senderDomain"],
  });
  const storedDomains = new Set(stored.map((s) => s.senderDomain));
  const pendingDomains = encryptedLogs
    .map((l) => l.senderDomain)
    .filter((d) => !storedDomains.has(d));

  return NextResponse.json({
    stored: stored.map((s) => ({ senderDomain: s.senderDomain, updatedAt: s.updatedAt })),
    pending: pendingDomains,
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { senderDomain, password } = (await req.json()) as {
    senderDomain?: string;
    password?: string;
  };

  if (!senderDomain || !password) {
    return NextResponse.json({ error: "senderDomain and password required" }, { status: 400 });
  }

  const encryptedPassword = encrypt(password);

  await prisma.statementPassword.upsert({
    where: { userId_senderDomain: { userId, senderDomain } },
    update: { encryptedPassword },
    create: { userId, senderDomain, encryptedPassword },
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Write DELETE route**

Create `src/app/api/settings/statement-passwords/[domain]/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: { domain: string } };

export async function DELETE(_req: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const domain = decodeURIComponent(params.domain);

  await prisma.statementPassword.deleteMany({
    where: { userId: session.user.id, senderDomain: domain },
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/settings/statement-passwords/
git commit -m "feat(api): add statement passwords GET/POST/DELETE endpoints"
```

---

## Task 4: Statement Passwords Settings Tab

**Files:**
- Modify: `src/app/(app)/settings/page.tsx`

- [ ] **Step 1: Read the settings page**

Read `src/app/(app)/settings/page.tsx` in full to understand current tab structure.

- [ ] **Step 2: Add tab and panel**

The settings page has tabs. Add a "Statement Passwords" tab. The tab panel content:

```typescript
// State for the Statement Passwords tab
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
  const data = await res.json();
  setPasswords(data);
  setPwLoading(false);
};

// Load when this tab is activated
useEffect(() => {
  if (activeTab === "statement-passwords") {
    loadPasswords();
  }
}, [activeTab]);

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
```

Tab panel JSX:

```typescript
{activeTab === "statement-passwords" && (
  <div>
    <h2 className="text-lg font-semibold text-gray-900 mb-1">Statement Passwords</h2>
    <p className="text-sm text-gray-500 mb-6">
      Some bank statements arrive as password-protected PDFs. Enter the password for each sender so Financial Manager can read them.
    </p>

    {pwLoading && <p className="text-sm text-gray-400">Loading…</p>}

    {passwords && (
      <>
        {/* Pending — encrypted PDFs found, no password yet */}
        {passwords.pending.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-orange-700 mb-3">
              ⚠️ Encrypted statements found ({passwords.pending.length})
            </h3>
            <div className="space-y-3">
              {passwords.pending.map((domain) => (
                <div key={domain} className="flex items-center gap-3 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                  <span className="flex-1 text-sm font-medium text-gray-700">{domain}</span>
                  <input
                    type="password"
                    placeholder="Enter password"
                    value={newPassword[domain] ?? ""}
                    onChange={(e) => setNewPassword((prev) => ({ ...prev, [domain]: e.target.value }))}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-48"
                  />
                  <button
                    onClick={() => handleSavePassword(domain)}
                    disabled={savingPw[domain] || !newPassword[domain]}
                    className="px-4 py-1.5 bg-[#5b7cfa] text-white text-sm rounded-lg hover:bg-[#4a6af0] disabled:opacity-50"
                  >
                    {savingPw[domain] ? "Saving…" : "Save"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stored passwords */}
        {passwords.stored.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Stored passwords</h3>
            <div className="space-y-2">
              {passwords.stored.map((entry) => (
                <div key={entry.senderDomain} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-700">{entry.senderDomain}</span>
                  <button
                    onClick={() => handleDeletePassword(entry.senderDomain)}
                    className="text-sm text-red-500 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {passwords.pending.length === 0 && passwords.stored.length === 0 && (
          <p className="text-sm text-gray-400">No encrypted statements found yet.</p>
        )}
      </>
    )}
  </div>
)}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/page.tsx"
git commit -m "feat(settings): add Statement Passwords tab"
```

---

## Self-Check

- [x] `pdf-parse` installed and importable
- [x] `fetchPdfAttachment` exported from `gmail.ts` — fetches attachment bytes, tries pdfParse, returns `{status, text/error}`
- [x] Encrypted PDF detection: `pdfParse` error message contains "password" or "encrypted" → `status: "encrypted"`
- [x] `fetchFullMessage` returns `hasPdfAttachment` and `pdfOutcome` fields
- [x] Chunk and advance routes log `skipped_pdf_encrypted` and increment `encryptedBlockedCount`
- [x] GET /api/settings/statement-passwords returns both `stored` (domain + date) and `pending` (encrypted domains with no password)
- [x] POST /api/settings/statement-passwords encrypts password with AES-256-GCM (via `encrypt()` from crypto.ts)
- [x] DELETE /api/settings/statement-passwords/[domain] removes by domain
- [x] Settings "Statement Passwords" tab shows pending domains (orange warning) + stored passwords
- [x] Password input per domain; save stores encrypted password
- [x] Stored passwords show with remove button
