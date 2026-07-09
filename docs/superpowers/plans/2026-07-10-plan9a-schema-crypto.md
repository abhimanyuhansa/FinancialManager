# Plan 9a: Schema + Seed Fix + Crypto Lib

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MerchantRule, StatementPassword, and ParseLog models to Prisma schema; add `encryptedBlockedCount` to SyncJob; fix seed data source tag; create AES-256-GCM crypto lib.

**Architecture:** Pure schema + utility changes. No UI, no API routes. Everything else in Plans 9b–9g depends on this foundation. Run migration, update seed, generate env key.

**Tech Stack:** Prisma 7, Node.js `crypto` module, TypeScript, Neon PostgreSQL

---

## File Map

| File | Action |
|------|--------|
| `prisma/schema.prisma` | Add 3 new models + `encryptedBlockedCount` to SyncJob + relations to User |
| `prisma/seed.ts` | Change seeded transaction `source` from `"gmail"` to `"seed"` |
| `src/lib/crypto.ts` | New — AES-256-GCM encrypt/decrypt |
| `.env.local` | Add `STATEMENT_ENCRYPTION_KEY` (32 bytes hex) and `CRON_SECRET` |
| `tests/lib/crypto.test.ts` | New — encrypt/decrypt round-trip tests |

---

## Task 1: Update Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add new models and update existing ones**

Open `prisma/schema.prisma`. Make the following changes:

**1a. Add `encryptedBlockedCount` field to SyncJob model:**

```prisma
model SyncJob {
  id                    String    @id @default(cuid())
  userId                String
  status                String    @default("running")
  totalEmails           Int       @default(0)
  processedEmails       Int       @default(0)
  newTransactions       Int       @default(0)
  skippedEmails         Int       @default(0)
  encryptedBlockedCount Int       @default(0)
  isRetrigger           Boolean   @default(false)
  startedAt             DateTime  @default(now())
  completedAt           DateTime?
  messageIds            String?
  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**1b. Add relations to User model** (add these lines inside the User model, after `syncJobs SyncJob[]`):

```prisma
  merchantRules      MerchantRule[]
  statementPasswords StatementPassword[]
  parseLogs          ParseLog[]
```

**1c. Add 3 new models** at the end of the file (after ReconciliationLog):

```prisma
model MerchantRule {
  id           String   @id @default(cuid())
  userId       String
  merchantName String
  category     String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, merchantName])
}

model StatementPassword {
  id                String   @id @default(cuid())
  userId            String
  senderDomain      String
  encryptedPassword String
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, senderDomain])
}

model ParseLog {
  id             String    @id @default(cuid())
  userId         String
  syncJobId      String
  gmailMsgId     String
  senderDomain   String
  emailDate      DateTime?
  bodyLengthRaw  Int
  bodyLengthSent Int
  wasTruncated   Boolean   @default(false)
  batchSize      Int       @default(1)
  outcome        String
  geminiConfidence Float?
  parsedMerchant String?
  parsedAmount   Float?
  transactionId  String?
  errorDetail    String?
  createdAt      DateTime  @default(now())
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, syncJobId])
  @@index([userId, gmailMsgId])
  @@index([createdAt])
}
```

- [ ] **Step 2: Generate and run migration**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager
npx prisma migrate dev --name plan9a_schema
```

Expected output: `The following migration(s) have been created and applied from new schema changes: migrations/YYYYMMDDHHMMSS_plan9a_schema`

- [ ] **Step 3: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected output: `✓ Generated Prisma Client`

- [ ] **Step 4: Verify schema compiles**

```bash
npx prisma validate
```

Expected output: `The schema at prisma/schema.prisma is valid`

---

## Task 2: Fix Seed Data Source Tag

**Files:**
- Modify: `prisma/seed.ts`

- [ ] **Step 1: Find the source field in seed transactions**

In `prisma/seed.ts`, find all occurrences of `source: "gmail"`. There will be a `transactions` array where each item has `source: "gmail"` (or it may be set via the upsert call).

- [ ] **Step 2: Change source to "seed"**

Replace every `source: "gmail"` with `source: "seed"` in the seed transactions data. Also ensure the upsert logic doesn't overwrite `source` if the transaction already exists with a different source.

The upsert block should look like:
```typescript
await prisma.transaction.upsert({
  where: { userId_fingerprint: { userId: user.id, fingerprint: tx.fingerprint } },
  update: {}, // do NOT update source on existing records
  create: {
    ...tx,
    userId: user.id,
    source: "seed",
  },
});
```

- [ ] **Step 3: Re-run seed to verify**

```bash
npx prisma db seed
```

Expected output: `🌱 The seed command has been executed.`

Then verify in Prisma Studio that seeded transactions have `source = "seed"`:

```bash
npx prisma studio
```

Open `Transaction` table, confirm `source` column shows `"seed"` for seeded rows.

- [ ] **Step 4: Commit schema + seed changes**

```bash
git add prisma/schema.prisma prisma/seed.ts prisma/migrations/
git commit -m "feat(schema): add MerchantRule, StatementPassword, ParseLog; fix seed source tag"
```

---

## Task 3: Create Crypto Library

**Files:**
- Create: `src/lib/crypto.ts`
- Create: `tests/lib/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/crypto.test.ts`:

```typescript
import { encrypt, decrypt } from "@/lib/crypto";

describe("AES-256-GCM encrypt/decrypt", () => {
  beforeAll(() => {
    // Set a test key: 32 bytes = 64 hex chars
    process.env.STATEMENT_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  it("round-trips a plaintext string", () => {
    const plaintext = "mySecretPassword123";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const plaintext = "samePassword";
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
    expect(decrypt(c1)).toBe(plaintext);
    expect(decrypt(c2)).toBe(plaintext);
  });

  it("ciphertext format is hex:hex:hex", () => {
    const ciphertext = encrypt("test");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(p).toMatch(/^[0-9a-f]+$/));
  });

  it("throws on tampered ciphertext", () => {
    const ciphertext = encrypt("test");
    const [enc, iv, tag] = ciphertext.split(":");
    const tampered = `${enc}ff:${iv}:${tag}`;
    expect(() => decrypt(tampered)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/i575379/Desktop/Repositories/POC/FinancialManager
npx jest tests/lib/crypto.test.ts --no-coverage
```

Expected: FAIL — `Cannot find module '@/lib/crypto'`

- [ ] **Step 3: Implement crypto.ts**

Create `src/lib/crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

function getKey(): Buffer {
  const hex = process.env.STATEMENT_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("STATEMENT_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${encrypted.toString("hex")}:${iv.toString("hex")}:${authTag.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const key = getKey();
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [enc, iv, tag] = parts.map((s) => Buffer.from(s, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/lib/crypto.test.ts --no-coverage
```

Expected: PASS — 4 tests passing

- [ ] **Step 5: Generate environment variables**

Run this once to generate a secure encryption key and cron secret:

```bash
node -e "const {randomBytes}=require('crypto'); console.log('STATEMENT_ENCRYPTION_KEY=' + randomBytes(32).toString('hex')); console.log('CRON_SECRET=' + randomBytes(32).toString('hex'));"
```

Copy the output and add both values to `.env.local`. The file already exists — append these two lines:

```
STATEMENT_ENCRYPTION_KEY=<paste 64-char hex value here>
CRON_SECRET=<paste 64-char hex value here>
```

**Do not commit `.env.local`** — it's already in `.gitignore`.

Also add these as Vercel environment variables (via Vercel dashboard → Project → Settings → Environment Variables):
- `STATEMENT_ENCRYPTION_KEY`
- `CRON_SECRET`

- [ ] **Step 6: Commit crypto lib and tests**

```bash
git add src/lib/crypto.ts tests/lib/crypto.test.ts
git commit -m "feat(crypto): add AES-256-GCM encrypt/decrypt for statement passwords"
```

---

## Self-Check

- [x] MerchantRule, StatementPassword, ParseLog models added to schema
- [x] `encryptedBlockedCount` added to SyncJob
- [x] User model has all 3 new relations
- [x] Seed `source` changed from `"gmail"` to `"seed"`
- [x] Migration generated and applied
- [x] `crypto.ts` with round-trip tests
- [x] Env vars documented (not committed)
