# Adaptive LLM Parsing Cache — Design Spec

**Goal:** Eliminate redundant Gemini calls for recurring email formats by learning deterministic extraction templates from successfully parsed emails, while never caching transaction-specific values.

**Architecture:** Three-tier parse chain inside `advanceJob` (Tier 3 sender classification removed from v1 — see Removed from v1 section). Gemini is the teacher: it parses, generates a normalized template, and validates shadow templates. Once a template is promoted, matching emails are parsed locally with zero LLM cost.

**Tech Stack:** Next.js 15 App Router, TypeScript, Prisma 7, Neon PostgreSQL, Gemini 2.0 Flash Lite, Vercel serverless.

---

## Parse Chain (three tiers)

```
Static parser            [existing, unchanged]
  ↓ insufficient_data
Tier 1: Exact result cache     [new — skip re-parse on reprocessJob retry]
  ↓ miss
Tier 2: Learned template cache [new — core feature]
  ↓ miss, or template is SHADOW/DEGRADED
Tier 3: Gemini batch           [existing — fallback + teacher]
```

Static parser runs first, unchanged. Only `insufficient_data` emails enter the cache chain. The Gemini batch is one HTTP request regardless of how many emails need it; the tier system only controls which emails are included in that batch.

**Tier 1 use case:** Normal syncs deduplicate by `gmailMsgId` before calling `advanceJob`, so the same message is never re-submitted in a normal flow. The exact cache targets `reprocessJob`: when an operator manually retriggers a failed job, the same `gmailMsgId` set is re-submitted. The exact cache returns the previously resolved transaction without re-invoking Gemini.

---

## Template Hash Normalization Algorithm

The `templateHash` is a SHA-256 of the **canonical normalized form** of the email. The same algorithm must be used during both template learning (after Gemini parse) and template lookup (before DB query). Any divergence causes a cache miss for every email.

**Algorithm (applied to both subject and body separately, then concatenated before hashing):**

```typescript
function canonicalise(text: string): string {
  return text
    .toLowerCase()                         // 1. lowercase
    .replace(/\r\n/g, "\n")               // 2. normalise line endings
    .replace(/[ \t]+/g, " ")              // 3. collapse horizontal whitespace
    .replace(/\n{3,}/g, "\n\n")           // 4. collapse 3+ blank lines → 2
    .trim();                               // 5. strip leading/trailing whitespace
}

function templateHash(subject: string, body: string): string {
  const canonical = canonicalise(subject) + "\n---\n" + canonicalise(body);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}
```

The separator `\n---\n` between subject and body prevents subject/body boundary confusion.

**Important:** The hash is computed from the **original** subject and body (after canonicalisation), not from the template with placeholders. The hash identifies the structural shape of the raw email, used to find a matching template. The template itself (with placeholders) is stored in `subjectTemplate`/`bodyTemplate`.

```prisma
model ParseTemplate {
  id                   String    @id @default(cuid())
  userId               String
  senderDomain         String
  templateHash         String    // SHA-256 of normalised subjectTemplate + bodyTemplate
  parserVersion        String    // manually-managed compatibility version
  taxonomyVersion      String    // stored for reference; NOT part of unique key
  status               String    // SHADOW | ACTIVE | DEGRADED | DISABLED
  subjectTemplate      String    // normalised subject with placeholders
  bodyTemplate         String    // normalised body with placeholders
  extractors           Json      // field extractor definitions (see Extractor Schema)
  hitCount             Int       @default(0)   // all-time successful uses
  failCount            Int       @default(0)   // all-time failures
  consecutiveSuccesses Int       @default(0)   // drives promotion
  consecutiveFailures  Int       @default(0)   // drives DISABLED transition
  promotedAt           DateTime?               // last transition to ACTIVE
  lastUsedAt           DateTime?
  lastFailedAt         DateTime?
  disabledReason       String?   // "consecutive_shadow_failures" | "consecutive_degraded_failures" | "manual"
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  user                 User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, senderDomain, templateHash, parserVersion])
  @@index([userId, senderDomain, status])
}
```

**Unique lookup key:** `(userId, senderDomain, templateHash, parserVersion)`

`taxonomyVersion` is stored as metadata only. Taxonomy changes (new categories, renamed subCategories) affect classification, not extraction. Storing it allows detecting stale classification without invalidating structurally-correct templates.

---

## Extractor Schema (`extractors` JSON)

Each key is a field name. Each value is one of two forms:

```typescript
// Dynamic: extracted via regex
type RegexExtractor = {
  regex: string;      // ECMAScript regex pattern (no flags — applied case-insensitive)
  group: number;      // capture group index
  transform: TransformName;
};

// Static: value is known from the template itself
type StaticExtractor = {
  static: string;
};

type TransformName =
  | "parseAmount"        // strip commas, parse float, reject ≤ 0
  | "normaliseDate"      // → YYYY-MM-DD (reuses existing normaliseDate logic)
  | "debitCreditToType"  // "debited" → "expense", "credited" → "income"
  | "trimMerchant"       // trim + collapse whitespace
  | "lowercase";         // VPA normalisation
```

Transform names are a closed enum defined in `parseTemplateCache.ts`. No `eval`, no dynamic code.

**Example:**
```json
{
  "amount":          { "regex": "Rs\\.\\s*([\\d,]+(?:\\.\\d{1,2})?)", "group": 1, "transform": "parseAmount" },
  "currency":        { "static": "INR" },
  "date":            { "regex": "on\\s+(\\d{2}-\\d{2}-\\d{2})", "group": 1, "transform": "normaliseDate" },
  "transactionType": { "regex": "(debited|credited)", "group": 1, "transform": "debitCreditToType" },
  "merchant":        { "regex": "at\\s+([A-Z][A-Z\\s]+?)(?:\\s|$)", "group": 1, "transform": "trimMerchant" },
  "vpa":             { "regex": "VPA\\s+([\\w.@\\-]+)", "group": 1, "transform": "lowercase" }
}
```

Required fields: `amount`, `currency`, `date`, `transactionType`. Optional: `merchant`, `vpa`. A template with no field extractors and only a `category`/`subCategory` in metadata acts as a Tier 3 sender classification record.

---

## Extractor Generation (from Gemini Output)

After Gemini returns a successfully parsed result **with** `subjectTemplate` and `bodyTemplate`, the extractors are derived algorithmically — no second LLM call required.

**Algorithm for each dynamic field:**

1. Locate the resolved value in the original body (e.g., `"1,234.56"` for amount).
2. Find the corresponding placeholder position in `bodyTemplate` (e.g., `{{AMOUNT}}`).
3. Extract the literal text immediately before the placeholder (up to 20 chars) and immediately after (up to 20 chars) as left/right anchors.
4. Construct a regex: `{leftAnchor}({capturePattern}){rightAnchor}` where `capturePattern` is field-specific (see table below).
5. Escape all regex metacharacters in the anchor strings.
6. Validate the generated regex against the original body — it must match and the capture group must equal the original resolved value. If validation fails, discard the extractor for that field (the template can still be stored if required fields have extractors; optional fields may be absent).

**Capture patterns by field:**

| Field | Capture pattern |
|---|---|
| `amount` | `[\d,]+(?:\.\d{1,2})?` |
| `currency` | static extractor (value from Gemini result) |
| `date` | `\d{1,4}[-\/]\d{1,2}[-\/]\d{1,2}` or `\d{2}-\d{2}-\d{2}` — try both, use whichever matches |
| `transactionType` | `debited\|credited` |
| `merchant` | `[A-Za-z][A-Za-z0-9\s\.\-&']+?` |
| `vpa` | `[\w.\@\-]+` |

**Regex safety:** Before storing any regex, run it through a safe-regex validator (`safe-regex` npm package or equivalent RE2 check). Any regex that fails the safety check is discarded for that field. A template missing only optional field extractors is still stored; a template missing any required field extractor is not stored (Gemini result is used as-is and no template is written).

---

## Template Lifecycle

### States

```
SHADOW  →  ACTIVE
ACTIVE  →  DEGRADED
DEGRADED → ACTIVE  (recovery)
DEGRADED → DISABLED
SHADOW  → DISABLED
DISABLED  (terminal)
```

### Transition Rules

| Event | From | Action |
|---|---|---|
| Agreement with Gemini | SHADOW or DEGRADED | `consecutiveSuccesses++`, reset `consecutiveFailures`. If `consecutiveSuccesses >= 3` → promote to ACTIVE, set `promotedAt`. |
| Disagreement with Gemini | SHADOW or DEGRADED | reset `consecutiveSuccesses`, `consecutiveFailures++`, `failCount++`. If `consecutiveFailures >= 3` → DISABLED. |
| Successful extraction + validation | ACTIVE | `hitCount++`, reset `consecutiveFailures`. |
| Extraction or validation failure | ACTIVE | `failCount++`, `consecutiveFailures++`, `lastFailedAt = now()`. If `consecutiveFailures >= 2` → DEGRADED (reset `consecutiveSuccesses` and `consecutiveFailures`). |
| Confirmed output mismatch (post-Gemini) | ACTIVE | Treat as extraction failure above. Note: user-correction feedback (TransactionPanel edit → template failure signal) is out of scope for v1; failures in ACTIVE state are limited to extraction errors and validation failures within the sync pipeline. |
| Admin action | any | → DISABLED with `disabledReason = "manual"`. |

**DISABLED** is terminal. A structurally changed email (bank redesigns template) naturally produces a different `templateHash`, creating a new template under the same sender. Stale DISABLED records are pruned by the existing 30-day parse log cron — add `ParseTemplate` to the same cron using `lastUsedAt`.

### Concurrency Safety

Vercel can run multiple `advance` invocations in parallel. All counter increments and status transitions must use atomic Prisma operations:

```typescript
// Correct — atomic increment + conditional transition in one query
await prisma.parseTemplate.updateMany({
  where: { id: template.id, status: "SHADOW" },  // status guard prevents double-transition
  data: {
    consecutiveSuccesses: { increment: 1 },
    consecutiveFailures: 0,
  },
});
// Follow with a separate updateMany to promote only if threshold is met,
// using a WHERE consecutiveSuccesses >= 3 guard so only one concurrent
// caller wins the transition.
```

Never read-then-write counters in application memory. Always use `{ increment: 1 }` and WHERE guards on status fields so concurrent updates are idempotent.

---

## Shadow Comparison Rules

A template result **agrees** with Gemini when all applicable fields match within tolerance:

| Field | Match condition |
|---|---|
| `amount` | `Math.round(a * 100) === Math.round(b * 100)` — avoid float equality |
| `currency` | Uppercase ISO code, exact |
| `date` | Calendar date only: `YYYY-MM-DD` substring of both, after stripping time |
| `transactionType` | Exact: `"expense"` or `"income"` |
| `merchant` | Trim + lowercase + collapse whitespace, then exact |
| `vpa` | Lowercase exact when present in either output. **Presence mismatch counts as disagreement.** |

A missing required field (amount, currency, date, transactionType) always counts as disagreement.

---

## Parser Version

```typescript
// src/lib/parseTemplateCache.ts
export const PARSER_VERSION = "1";
```

Increment **only** when normalization rules, extractor format, or template matching logic change incompatibly. Do **not** increment for taxonomy or merchant-category mapping changes.

When incremented: existing templates are bypassed (lookup key no longer matches), emails fall back to Gemini and relearn templates under the new version. Old templates accumulate until pruned by the `lastUsedAt` TTL.

---

## Gemini Schema Extension

Add two optional fields to `GeminiEmailResult` and the batch response schema:

```typescript
subjectTemplate?: string;  // normalised subject with {{PLACEHOLDER}} substitutions
bodyTemplate?: string;     // normalised body with {{PLACEHOLDER}} substitutions
```

Extend `BATCH_SYSTEM_PROMPT` with:

> "For each successfully parsed transaction email, also return `subjectTemplate` and `bodyTemplate`: copies of the subject and body with all dynamic values replaced by typed placeholders. Use: `{{AMOUNT}}`, `{{DATE}}`, `{{MERCHANT}}`, `{{VPA}}`, `{{ACCOUNT}}`, `{{ORDER_ID}}`, `{{TRANSACTION_ID}}`, `{{CURRENCY}}`. Replace every occurrence of each dynamic value, not just the first."

These fields are optional in the response schema — existing tests and callers remain valid if Gemini omits them.

---

## Batch Preload Pattern (no N+1 queries)

Inside `advanceJob`, after the static parser pass:

```
1. Collect insufficientEmails[]
2. For each: check Tier 1 (ParseLog lookup by gmailMsgId — one query for all)
3. For remaining: normalise subject+body → templateHash (CPU only, no I/O)
4. Collect unique (userId, senderDomain, templateHash, parserVersion) keys
5. ONE Prisma query: findMany where key IN [collected keys]
6. Build invocationMap: Map<lookupKey, ParseTemplate>
7. Process batch from invocationMap (zero further lookups for template reads)
8. After Gemini: upsertTemplate() writes to DB + updates invocationMap immediately
   → next email in the same batch can reuse the new template in SHADOW mode
```

Module-level warm cache (`Map<string, ParseTemplate>`) is populated from the invocationMap after each batch. On the next Vercel invocation (warm start), it seeds step 6 without a DB query. Always treated as best-effort: a cache miss falls back to the DB query.

**Warm cache TTL:** Each entry stores a `cachedAt` timestamp (not persisted — only in the module Map). Before serving an entry from the warm cache, check `Date.now() - entry.cachedAt > 5 * 60 * 1000` (5 minutes). A stale entry is evicted and the lookup falls through to the DB query. This prevents a warm Vercel instance from serving a DISABLED or DEGRADED template that was updated in DB by a concurrent invocation.

---

## Data Flow in `advanceJob` (modified)

```
Static pass → parsed/not_transaction/insufficient_data  (unchanged)

For insufficient_data emails:
  a. Tier 1 check (exact cache via ParseLog — batch query)
     → hit: reuse existing transaction, write ParseLog resolvedBy="exact_cache", skip

  b. Generate templateHash from normalized subject+body

  c. Batch preload all template keys (one DB query)

  d. Per email:
     ACTIVE template found:
       applyTemplate() + validate()
       → success: add to templateResolved[], write ParseLog resolvedBy="template"
       → failure: recordFailure(), add to geminiQueue, needsComparison=false

     SHADOW or DEGRADED template found:
       applyTemplate() → store shadowResult (may be null if extraction fails)
       if shadowResult is null: recordFailure(), add to geminiQueue with needsComparison=false
       if shadowResult is non-null: add to geminiQueue with needsComparison=true

     No template:
       add to geminiQueue with isNewTemplate=true

  e. Gemini batch call (geminiQueue only — may be empty)

  f. Process Gemini results:
     needsComparison=true:
       compareOutputs(shadowResult, geminiResult)
       → agree:    recordHit() → may promote
       → disagree: recordFailure() → may degrade/disable
       → always use Gemini result as the transaction value
     isNewTemplate=true:
       normaliseEmailForTemplate(body, subject, geminiResult)
       → upsertTemplate(SHADOW, extractors, ...)
       → update invocationMap
     plain gemini (active failure fallback):
       use Gemini result as-is

  g. Upsert transactions (template-resolved + gemini-resolved)

  h. Write ParseLogs — include resolvedBy: "static"|"template"|"gemini"|"exact_cache"
```

---

## ParseLog Extension

Add one column:

```prisma
resolvedBy  String?   // "static" | "template" | "gemini" | "exact_cache"
```

This powers future analytics: what percentage of emails are resolved without a Gemini call? Visible in the Settings → Parse Logs tab.

---

## New Files

| File | Responsibility |
|---|---|
| `src/lib/parseTemplateCache.ts` | `PARSER_VERSION`, `templateHash`, `canonicalise`, module-level warm cache (with 5-min TTL), `preloadTemplates`, `lookupTemplate`, `applyTemplate`, `deriveExtractors`, `compareOutputs`, `upsertTemplate`, `recordHit`, `recordFailure`, state transition helpers |
| `src/lib/exactResultCache.ts` | Tier 1: batch ParseLog lookup by `gmailMsgId` (covers `reprocessJob` reruns), returns linked transaction if outcome=parsed |
| `prisma/migrations/YYYYMMDD_add_parse_template/migration.sql` | `ParseTemplate` table + indexes |

## Modified Files

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `ParseTemplate` model; add `resolvedBy` to `ParseLog`; add `ParseTemplate[]` relation to `User` |
| `src/lib/gemini.ts` | Add `subjectTemplate?`, `bodyTemplate?` to `GeminiEmailResult`; extend `BATCH_SYSTEM_PROMPT` |
| `src/app/api/gmail/sync/advance/route.ts` | Replace two-tier logic with three-tier chain per data flow above |

---

## What Is Never Cached

The following values exist only in individual `Transaction` and `ParseLog` records. They are never stored in `ParseTemplate`:

- Transaction amount
- Transaction date
- Merchant name (as a resolved value)
- VPA address (as a resolved value)
- Account number
- Order ID / Transaction ID
- Any value extracted from a specific email body

Templates store only structural patterns (regexes, placeholder positions) and classification metadata (category, subCategory). The actual values are always extracted fresh from the current email at match time.

**PII boundary:** The `bodyTemplate` field stores the email body after all dynamic values have been replaced by typed placeholders. The full placeholder set (`{{AMOUNT}}`, `{{DATE}}`, `{{MERCHANT}}`, `{{VPA}}`, `{{ACCOUNT}}`, `{{ORDER_ID}}`, `{{TRANSACTION_ID}}`, `{{CURRENCY}}`) must be complete — if a dynamic value is not covered by a placeholder, the Gemini prompt must be updated to cover it before the template is stored. The `bodyTemplate` must never contain a raw account number, VPA, or transaction ID. The Gemini prompt instruction (see Gemini Schema Extension) is the enforcement point.

---

## Pruning

Add `ParseTemplate` to the existing 30-day cron pruning in `advance/route.ts`:

```typescript
await prisma.parseTemplate.deleteMany({
  where: {
    OR: [
      { lastUsedAt: { lt: cutoff } },           // unused for 30 days
      { status: "DISABLED", updatedAt: { lt: cutoff } },  // old disabled records
    ],
  },
});
```

---

## Testing Approach

- `parseTemplateCache.ts`: unit tests for `templateHash` (canonicalisation determinism — same input always produces same hash), `applyTemplate` (extractor application), `compareOutputs` (all tolerance rules), and all state transition functions (including concurrency-safe counter increments). No DB or Gemini required.
- `exactResultCache.ts`: unit test with mocked Prisma — hit and miss cases, including the `reprocessJob` scenario.
- `advance/route.ts` integration path: existing 76 tests must continue to pass. New tests for the three-tier routing logic using mocked cache and mocked Gemini.
- Shadow promotion: test that 3 consecutive agreements promote SHADOW → ACTIVE, and 3 consecutive disagreements in SHADOW → DISABLED.
- Extractor generation: unit tests for `deriveExtractors` — anchor extraction, regex construction, safety validation, and the case where a required-field extractor fails safety check (template not stored).
- Warm cache TTL: unit test that an entry older than 5 minutes is evicted and the DB is queried.

---

## Removed from v1

**Tier 3 — Sender classification cache** (category/subCategory defaults per sender domain) was included in the original four-tier design but is removed from v1 due to underspecification: the storage format, lookup path, how classification hints flow into Gemini prompt construction, and the interaction with the existing taxonomy system were not fully resolved. The `ParseTemplate` model's `extractors` JSON field could support a classification-only record (no field extractors, only metadata) as a future extension, but this path is not implemented in v1. Gemini remains solely responsible for category/subCategory assignment in v1.
