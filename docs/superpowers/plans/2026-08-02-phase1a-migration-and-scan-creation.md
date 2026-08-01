# Phase 1A: Migration Proof + Scan Creation Domain Service

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the 5 pending migrations are safe on a Neon test branch, apply them to live, then implement the idempotent scan-creation domain service and its protected `POST /api/gmail/scan` start API.

**Architecture:** Stage 1 is purely operational — create a Neon branch from the live database, run `prisma migrate deploy`, verify the outcome, then apply to live. Stage 2 is a new domain service `ScanService.startScan()` that creates a `UserEmailFilter` + `EmailFilterVersion` + `EmailScanRun` atomically, plus a Next.js API route that calls it. The service is idempotent on `clientRequestId`.

**Tech Stack:** Neon branching CLI (`neon`), Prisma 7, Next.js 15 App Router, Auth.js v5, Jest (unit), existing `src/lib/scan/` pattern.

---

## Stage 1 — Prove Migrations on Neon Test Branch

### Task 1: Create a Neon test branch from live

**Files:** No code changes — purely operational.

- [ ] **Step 1: List your Neon projects and find the production project ID**

  ```bash
  neon projects list
  ```

  Note the project ID (looks like `ep-...` or a UUID). Also note the main branch ID shown.

- [ ] **Step 2: Create a test branch from the main live branch**

  ```bash
  neon branches create \
    --project-id <YOUR_PROJECT_ID> \
    --name migration-test-2026-08-02 \
    --parent main
  ```

  Note the new branch ID and connection string in the output.

- [ ] **Step 3: Get the connection string for the test branch**

  ```bash
  neon connection-string \
    --project-id <YOUR_PROJECT_ID> \
    --branch migration-test-2026-08-02 \
    --database-name neondb \
    --role-name neondb_owner
  ```

  This returns a `postgresql://...` URL. Copy it — you'll use it in the next task.

---

### Task 2: Run the 5 pending migrations against the test branch

**Files:**
- Modify (temporarily): `.env.local` — swap `DATABASE_URL` for the test branch URL, then swap back.

- [ ] **Step 1: Back up your current DATABASE_URL**

  Open `.env.local`. Find the `DATABASE_URL` line. Copy its value somewhere safe.

- [ ] **Step 2: Replace DATABASE_URL with the test branch connection string**

  In `.env.local`, replace the existing `DATABASE_URL` value with the Neon test branch connection string from Task 1 Step 3.

- [ ] **Step 3: Verify Prisma can reach the test branch**

  ```bash
  npx prisma migrate status
  ```

  Expected output: shows 18 applied migrations and 5 pending (same as live). This confirms you're on the test branch.

- [ ] **Step 4: Apply the 5 pending migrations**

  ```bash
  npx prisma migrate deploy
  ```

  Expected: all 5 migrations apply successfully with no errors. The parse-template bridge migrations will detect `stored_template_checksum IS NOT NULL` (already migrated) and return early. The phase1a and LLM drift migrations will add columns and tables.

- [ ] **Step 5: Verify final migration state**

  ```bash
  npx prisma migrate status
  ```

  Expected: "All migrations have been applied."

- [ ] **Step 6: Verify Prisma client generation works against the new schema**

  ```bash
  npx prisma validate && npx prisma generate
  ```

  Expected: no errors.

- [ ] **Step 7: Run the test suite against the test branch**

  ```bash
  npm test -- --runInBand
  ```

  Expected: all 36 suites, 279 tests pass. (Tests that use real DB will exercise the new tables; tests using mocks will pass regardless.)

- [ ] **Step 8: Restore DATABASE_URL to live Neon**

  In `.env.local`, restore the original `DATABASE_URL` value from Step 1.

- [ ] **Step 9: Verify you're back on live**

  ```bash
  npx prisma migrate status
  ```

  Expected: 18 applied, 5 pending.

---

### Task 3: Apply migrations to live Neon

**Pre-condition:** Tasks 1 and 2 completed without errors. The test branch proved all 5 migrations are safe.

**Files:** No code changes.

- [ ] **Step 1: Confirm with the user before proceeding**

  Show this summary and ask for explicit approval:
  - Test branch result: all 5 migrations applied cleanly
  - Parse-template bridge: no-ops (already-migrated path executed)
  - Phase 1A schema: 6 new tables, 3 new Account columns
  - LLM drift reconciliation: 3 nullable columns added with `IF NOT EXISTS`
  - No data loss, no destructive operations on live data

- [ ] **Step 2: Apply to live**

  ```bash
  npx prisma migrate deploy
  ```

  Expected: "5 migrations have been applied."

- [ ] **Step 3: Verify**

  ```bash
  npx prisma migrate status
  ```

  Expected: "All migrations have been applied."

- [ ] **Step 4: Run build to confirm no type errors**

  ```bash
  npm run build
  ```

  Expected: build passes.

- [ ] **Step 5: Commit status update**

  ```bash
  git add -A
  git commit -m "ops: apply 5 pending migrations to live Neon (phase1a + llm-drift)"
  ```

---

## Stage 2 — Idempotent Scan Creation Service + API

### Task 4: Write types for scan creation

**Files:**
- Modify: `src/lib/scan/types.ts` — add `CreateScanRequest` and `CreateScanResult`

- [ ] **Step 1: Write the failing type test**

  Create `tests/lib/scanCreate.test.ts`:

  ```typescript
  import type { CreateScanRequest, CreateScanResult } from "@/lib/scan/types";

  describe("scan creation types", () => {
    it("CreateScanRequest has required fields", () => {
      const req: CreateScanRequest = {
        userId: "u1",
        gmailAccountId: "a1",
        clientRequestId: "req-001",
        filterName: "My Filter",
        gmailQuery: "from:bank",
        fromDate: new Date("2026-01-01"),
        toDate: new Date("2026-07-01"),
      };
      expect(req.userId).toBe("u1");
    });

    it("CreateScanResult has scanRunId and status", () => {
      const result: CreateScanResult = {
        scanRunId: "run-1",
        status: "CREATED",
        created: true,
      };
      expect(result.status).toBe("CREATED");
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  ```bash
  npx jest tests/lib/scanCreate.test.ts --no-coverage
  ```

  Expected: FAIL — `CreateScanRequest` and `CreateScanResult` not exported from types.

- [ ] **Step 3: Add the types to `src/lib/scan/types.ts`**

  Append to the end of the existing file:

  ```typescript
  export type CreateScanRequest = {
    userId: string;
    gmailAccountId: string;
    clientRequestId: string;
    filterName: string;
    gmailQuery: string;
    fromDate: Date;
    toDate: Date;
    scanLimit?: number;
  };

  export type CreateScanResult = {
    scanRunId: string;
    status: ScanRunStatus;
    /** true = newly created; false = existing scan returned (idempotent) */
    created: boolean;
  };
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  npx jest tests/lib/scanCreate.test.ts --no-coverage
  ```

  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/scan/types.ts tests/lib/scanCreate.test.ts
  git commit -m "feat(scan): add CreateScanRequest and CreateScanResult types"
  ```

---

### Task 5: Write the scan creation domain service

**Files:**
- Create: `src/lib/scan/scanCreateService.ts`
- Create: `tests/lib/scanCreateService.test.ts`

**Context:** `EmailScanRun` requires a `UserEmailFilter` and `EmailFilterVersion`. For the MVP scan-creation path, we create one `UserEmailFilter` + `EmailFilterVersion` per call, then the `EmailScanRun`. The service is idempotent: if a scan with the same `(userId, clientRequestId)` already exists, it returns the existing run without creating duplicates. The filter and version are always created as part of the same transaction; this is safe because the `email_filter_version_immutable` trigger only blocks UPDATE, not INSERT.

- [ ] **Step 1: Write failing tests**

  Create `tests/lib/scanCreateService.test.ts`:

  ```typescript
  import { createScanRun, type ScanCreateStore } from "@/lib/scan/scanCreateService";
  import type { CreateScanRequest } from "@/lib/scan/types";

  const baseRequest: CreateScanRequest = {
    userId: "user-1",
    gmailAccountId: "acct-1",
    clientRequestId: "client-req-001",
    filterName: "Test Filter",
    gmailQuery: "from:bank",
    fromDate: new Date("2026-01-01"),
    toDate: new Date("2026-07-01"),
  };

  function makeMockStore(overrides?: Partial<ScanCreateStore>): ScanCreateStore {
    return {
      emailScanRun: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "run-new",
          status: "CREATED",
        }),
      },
      userEmailFilter: {
        create: jest.fn().mockResolvedValue({ id: "filter-1" }),
      },
      emailFilterVersion: {
        create: jest.fn().mockResolvedValue({ id: "version-1" }),
      },
      userEmailFilter_setCurrentVersion: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  describe("createScanRun", () => {
    it("creates filter, version, and scan run on first call", async () => {
      const store = makeMockStore();
      const result = await createScanRun(baseRequest, store);

      expect(result.scanRunId).toBe("run-new");
      expect(result.status).toBe("CREATED");
      expect(result.created).toBe(true);
      expect(store.userEmailFilter.create).toHaveBeenCalledTimes(1);
      expect(store.emailFilterVersion.create).toHaveBeenCalledTimes(1);
      expect(store.emailScanRun.create).toHaveBeenCalledTimes(1);
    });

    it("returns existing scan run when clientRequestId already exists (idempotent)", async () => {
      const store = makeMockStore({
        emailScanRun: {
          findFirst: jest.fn().mockResolvedValue({ id: "run-existing", status: "CREATED" }),
          create: jest.fn(),
        },
      });

      const result = await createScanRun(baseRequest, store);

      expect(result.scanRunId).toBe("run-existing");
      expect(result.created).toBe(false);
      expect(store.userEmailFilter.create).not.toHaveBeenCalled();
      expect(store.emailScanRun.create).not.toHaveBeenCalled();
    });

    it("passes gmailQuery into emailFilterVersion", async () => {
      const store = makeMockStore();
      await createScanRun(baseRequest, store);

      expect(store.emailFilterVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ gmailQuery: "from:bank" }),
        }),
      );
    });

    it("passes fromDate and toDate into emailScanRun", async () => {
      const store = makeMockStore();
      await createScanRun(baseRequest, store);

      expect(store.emailScanRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fromDate: new Date("2026-01-01"),
            toDate: new Date("2026-07-01"),
          }),
        }),
      );
    });

    it("sets scanLimit when provided", async () => {
      const store = makeMockStore();
      await createScanRun({ ...baseRequest, scanLimit: 100 }, store);

      expect(store.emailScanRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scanLimit: 100 }),
        }),
      );
    });

    it("omits scanLimit when not provided", async () => {
      const store = makeMockStore();
      await createScanRun(baseRequest, store);

      const callArgs = (store.emailScanRun.create as jest.Mock).mock.calls[0][0];
      expect(callArgs.data.scanLimit).toBeUndefined();
    });
  });
  ```

- [ ] **Step 2: Run to verify tests fail**

  ```bash
  npx jest tests/lib/scanCreateService.test.ts --no-coverage
  ```

  Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/scan/scanCreateService.ts`**

  ```typescript
  import { prisma } from "@/lib/prisma";
  import { isScanRunStatus } from "@/lib/scan/types";
  import type { CreateScanRequest, CreateScanResult } from "@/lib/scan/types";

  export type ScanCreateStore = {
    emailScanRun: {
      findFirst(args: unknown): Promise<{ id: string; status: string } | null>;
      create(args: unknown): Promise<{ id: string; status: string }>;
    };
    userEmailFilter: {
      create(args: unknown): Promise<{ id: string }>;
    };
    emailFilterVersion: {
      create(args: unknown): Promise<{ id: string }>;
    };
    userEmailFilter_setCurrentVersion(
      filterId: string,
      versionId: string,
    ): Promise<void>;
  };

  function makeDefaultStore(): ScanCreateStore {
    return {
      emailScanRun: {
        findFirst: (args) => prisma.emailScanRun.findFirst(args as Parameters<typeof prisma.emailScanRun.findFirst>[0]),
        create: (args) => prisma.emailScanRun.create(args as Parameters<typeof prisma.emailScanRun.create>[0]),
      },
      userEmailFilter: {
        create: (args) => prisma.userEmailFilter.create(args as Parameters<typeof prisma.userEmailFilter.create>[0]),
      },
      emailFilterVersion: {
        create: (args) => prisma.emailFilterVersion.create(args as Parameters<typeof prisma.emailFilterVersion.create>[0]),
      },
      userEmailFilter_setCurrentVersion: async (filterId, versionId) => {
        await prisma.userEmailFilter.update({
          where: { id: filterId },
          data: { currentVersionId: versionId },
        });
      },
    };
  }

  export async function createScanRun(
    request: CreateScanRequest,
    store: ScanCreateStore = makeDefaultStore(),
  ): Promise<CreateScanResult> {
    const { userId, gmailAccountId, clientRequestId, filterName, gmailQuery, fromDate, toDate, scanLimit } = request;

    // Idempotency check — return existing if already created
    const existing = await store.emailScanRun.findFirst({
      where: { userId, clientRequestId },
      select: { id: true, status: true },
    });

    if (existing) {
      if (!isScanRunStatus(existing.status)) {
        throw new Error(`Invalid persisted scan status: ${existing.status}`);
      }
      return { scanRunId: existing.id, status: existing.status, created: false };
    }

    // Create filter
    const filter = await store.userEmailFilter.create({
      data: {
        userId,
        gmailAccountId,
        name: filterName,
        isActive: true,
      },
      select: { id: true },
    });

    // Create first version (immutable after creation)
    const version = await store.emailFilterVersion.create({
      data: {
        emailFilterId: filter.id,
        version: 1,
        gmailQuery,
        includeRulesJson: [],
        excludeRulesJson: [],
        ruleSchemaVersion: 1,
        filterEvaluatorVersion: 1,
        createdBy: userId,
      },
      select: { id: true },
    });

    // Point filter at its current version
    await store.userEmailFilter_setCurrentVersion(filter.id, version.id);

    // Create the scan run
    const scanRun = await store.emailScanRun.create({
      data: {
        userId,
        gmailAccountId,
        clientRequestId,
        emailFilterId: filter.id,
        emailFilterVersionId: version.id,
        effectiveGmailQuery: gmailQuery,
        fromDate,
        toDate,
        ...(scanLimit !== undefined ? { scanLimit } : {}),
        filterRuleSchemaVersion: 1,
        filterEvaluatorVersion: 1,
        filterSnapshotJson: { gmailQuery, includeRules: [], excludeRules: [] },
        status: "CREATED",
      },
      select: { id: true, status: true },
    });

    return { scanRunId: scanRun.id, status: "CREATED", created: true };
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx jest tests/lib/scanCreateService.test.ts --no-coverage
  ```

  Expected: PASS (6 tests)

- [ ] **Step 5: Run full test suite to check for regressions**

  ```bash
  npm test -- --runInBand
  ```

  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add src/lib/scan/scanCreateService.ts tests/lib/scanCreateService.test.ts
  git commit -m "feat(scan): add idempotent createScanRun domain service"
  ```

---

### Task 6: POST /api/gmail/scan — protected start API

**Files:**
- Create: `src/app/api/gmail/scan/route.ts`
- Create: `tests/api/scan-create.test.ts`

**Context:** Auth.js `auth()` protects the route. Request body: `{ clientRequestId, filterName, gmailQuery, fromDate, toDate, scanLimit? }`. The route resolves the user's `gmailAccountId` from `Account` (first active Google account). Returns `201` on creation, `200` on idempotent hit, `400` on bad input, `401` on unauthenticated, `422` if no Google account found.

- [ ] **Step 1: Write failing API tests**

  Create `tests/api/scan-create.test.ts`:

  ```typescript
  import { POST } from "@/app/api/gmail/scan/route";
  import { auth } from "@/lib/auth";
  import { createScanRun } from "@/lib/scan/scanCreateService";
  import { prisma } from "@/lib/prisma";

  jest.mock("@/lib/auth");
  jest.mock("@/lib/scan/scanCreateService");
  jest.mock("@/lib/prisma", () => ({
    prisma: {
      account: {
        findFirst: jest.fn(),
      },
    },
  }));

  const mockAuth = auth as jest.MockedFunction<typeof auth>;
  const mockCreateScanRun = createScanRun as jest.MockedFunction<typeof createScanRun>;
  const mockAccountFindFirst = prisma.account.findFirst as jest.MockedFunction<
    typeof prisma.account.findFirst
  >;

  function makeRequest(body: unknown): Request {
    return new Request("http://localhost/api/gmail/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const validBody = {
    clientRequestId: "req-001",
    filterName: "My Filter",
    gmailQuery: "from:bank",
    fromDate: "2026-01-01",
    toDate: "2026-07-01",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as Awaited<ReturnType<typeof auth>>);
    mockAccountFindFirst.mockResolvedValue({ id: "acct-1" } as Awaited<ReturnType<typeof prisma.account.findFirst>>);
    mockCreateScanRun.mockResolvedValue({ scanRunId: "run-1", status: "CREATED", created: true });
  });

  describe("POST /api/gmail/scan", () => {
    it("returns 401 when unauthenticated", async () => {
      mockAuth.mockResolvedValue(null);
      const res = await POST(makeRequest(validBody));
      expect(res.status).toBe(401);
    });

    it("returns 400 when clientRequestId is missing", async () => {
      const res = await POST(makeRequest({ ...validBody, clientRequestId: undefined }));
      expect(res.status).toBe(400);
    });

    it("returns 400 when fromDate is missing", async () => {
      const res = await POST(makeRequest({ ...validBody, fromDate: undefined }));
      expect(res.status).toBe(400);
    });

    it("returns 422 when no Google account found", async () => {
      mockAccountFindFirst.mockResolvedValue(null);
      const res = await POST(makeRequest(validBody));
      expect(res.status).toBe(422);
    });

    it("returns 201 with scanRunId when scan created", async () => {
      const res = await POST(makeRequest(validBody));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.scanRunId).toBe("run-1");
      expect(body.created).toBe(true);
    });

    it("returns 200 when scan already exists (idempotent)", async () => {
      mockCreateScanRun.mockResolvedValue({ scanRunId: "run-1", status: "CREATED", created: false });
      const res = await POST(makeRequest(validBody));
      expect(res.status).toBe(200);
    });

    it("passes parsed dates to createScanRun", async () => {
      await POST(makeRequest(validBody));
      expect(mockCreateScanRun).toHaveBeenCalledWith(
        expect.objectContaining({
          fromDate: new Date("2026-01-01"),
          toDate: new Date("2026-07-01"),
          gmailAccountId: "acct-1",
        }),
      );
    });
  });
  ```

- [ ] **Step 2: Run to verify tests fail**

  ```bash
  npx jest tests/api/scan-create.test.ts --no-coverage
  ```

  Expected: FAIL — route not found.

- [ ] **Step 3: Implement `src/app/api/gmail/scan/route.ts`**

  ```typescript
  import { NextResponse } from "next/server";
  import { auth } from "@/lib/auth";
  import { prisma } from "@/lib/prisma";
  import { createScanRun } from "@/lib/scan/scanCreateService";

  export async function POST(request: Request) {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const { clientRequestId, filterName, gmailQuery, fromDate, toDate, scanLimit } = body;

    if (
      typeof clientRequestId !== "string" || !clientRequestId ||
      typeof filterName !== "string" || !filterName ||
      typeof gmailQuery !== "string" || !gmailQuery ||
      typeof fromDate !== "string" || !fromDate ||
      typeof toDate !== "string" || !toDate
    ) {
      return NextResponse.json(
        { error: "clientRequestId, filterName, gmailQuery, fromDate, toDate are required" },
        { status: 400 },
      );
    }

    const account = await prisma.account.findFirst({
      where: { userId: session.user.id, provider: "google", disconnectedAt: null },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    if (!account) {
      return NextResponse.json(
        { error: "No connected Google account found" },
        { status: 422 },
      );
    }

    const result = await createScanRun({
      userId: session.user.id,
      gmailAccountId: account.id,
      clientRequestId,
      filterName,
      gmailQuery,
      fromDate: new Date(fromDate),
      toDate: new Date(toDate),
      scanLimit: typeof scanLimit === "number" ? scanLimit : undefined,
    });

    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx jest tests/api/scan-create.test.ts --no-coverage
  ```

  Expected: PASS (7 tests)

- [ ] **Step 5: Run full test suite**

  ```bash
  npm test -- --runInBand
  ```

  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add src/app/api/gmail/scan/route.ts tests/api/scan-create.test.ts
  git commit -m "feat(scan): add POST /api/gmail/scan protected start endpoint"
  ```

---

### Task 7: Documentation update

**Files:**
- Modify: `CURRENT_STATUS.md`
- Modify: `OPEN_DEFECTS.md`

- [ ] **Step 1: Update CURRENT_STATUS.md**

  Replace the "Next task" section with:

  ```
  ## What works (updated 2026-08-02)
  [existing content, plus:]
  - 5 pending migrations applied to live Neon (phase1a scan schema + LLM drift reconciliation)
  - Phase 1A: `POST /api/gmail/scan` — idempotent scan creation, returns 201/200
  - Phase 1A: `GET /api/gmail/scan/{id}` — read-only scan status

  ## Next task
  Implement the scan advance worker: pick up CREATED scans, transition to DISCOVERING,
  page through Gmail API results, and write EmailSource + EmailScanItem rows.
  ```

- [ ] **Step 2: Close DEF-1 in OPEN_DEFECTS.md**

  Change DEF-1 status from `Open` to `Resolved` and add:
  `- Resolved: test-branched on Neon, proven clean, applied to live on 2026-08-02.`

- [ ] **Step 3: Commit docs**

  ```bash
  git add CURRENT_STATUS.md OPEN_DEFECTS.md
  git commit -m "docs: update status after phase1a migration and scan creation"
  ```

---

## Self-Review

### Spec coverage
- DEF-1 migration proof: Tasks 1–3 ✓
- Idempotent scan-creation domain service: Task 5 ✓
- Protected start API: Task 6 ✓
- Documentation update: Task 7 ✓

### Placeholder scan
- No TBDs, no "similar to above" steps
- All test code is complete
- All implementation code is complete

### Type consistency
- `CreateScanRequest` defined in Task 4, used in Task 5 and Task 6 — consistent
- `CreateScanResult` defined in Task 4, returned in Task 5 — consistent
- `ScanCreateStore` defined in Task 5, mock matches shape — consistent
- `isScanRunStatus` imported from `types.ts` in Task 5 — already exported there
