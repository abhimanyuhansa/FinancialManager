const mockAuth = jest.fn();
jest.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

const mockFindFirst = jest.fn();
const mockCreate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockUserUpdate = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: {
    syncJob: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      create: (...args: unknown[]) => mockCreate(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
      update: (...args: unknown[]) => mockUserUpdate(...args),
    },
  },
}));

const mockGetGmailToken = jest.fn();
jest.mock("@/lib/gmail", () => ({
  ...jest.requireActual("@/lib/gmail"),
  getGmailToken: (...args: unknown[]) => mockGetGmailToken(...args),
}));

const mockBuildGmailQuery = jest.fn();
jest.mock("@/lib/gmailQuery", () => ({
  buildGmailQueryFromDB: (...args: unknown[]) => mockBuildGmailQuery(...args),
}));

import { POST as startSync } from "@/app/api/gmail/sync/start/route";
import { GET as advanceSync } from "@/app/api/gmail/sync/advance/route";
import { NextRequest } from "next/server";

describe("static-only Gmail MVP API gates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LEGACY_TRANSACTION_INGESTION_ENABLED = "true";
    process.env.LLM_PARSING_ENABLED = "false";
  });

  afterEach(() => {
    delete process.env.LEGACY_TRANSACTION_INGESTION_ENABLED;
    delete process.env.LLM_PARSING_ENABLED;
    delete process.env.CRON_SECRET;
  });

  it("returns 503 before authentication or DB work after legacy cutover", async () => {
    process.env.LEGACY_TRANSACTION_INGESTION_ENABLED = "false";

    const response = await startSync(
      new Request("http://localhost/api/gmail/sync/start", { method: "POST" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "legacy_ingestion_disabled" });
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("persists a changed onboarding window and creates the legacy scan job", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockFindFirst.mockResolvedValue(null);
    mockGetGmailToken.mockResolvedValue("gmail-access-token");
    mockUserFindUnique.mockResolvedValue({
      gmailSyncedAt: null,
      syncFromDate: null,
    });
    mockUserUpdate.mockResolvedValue({});
    mockBuildGmailQuery.mockResolvedValue("after:2026/04/26");
    mockCreate.mockResolvedValue({ id: "job-1" });

    const response = await startSync(
      new Request("http://localhost/api/gmail/sync/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: "3m" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ jobId: "job-1" });
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { syncFromDate: expect.any(Date) },
    });
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        status: "scanning",
        gmailQuery: "after:2026/04/26",
      }),
    });
  });

  it("does not accept the cron secret from a URL query parameter", async () => {
    process.env.CRON_SECRET = "server-secret";
    mockAuth.mockResolvedValue(null);

    const response = await advanceSync(
      new NextRequest("http://localhost/api/gmail/sync/advance?secret=server-secret"),
    );

    expect(response.status).toBe(401);
  });
});
