const mockAuth = jest.fn();
jest.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

const mockCreateScanRun = jest.fn();
jest.mock("@/lib/scan/scanCreateService", () => ({
  createScanRun: (...args: unknown[]) => mockCreateScanRun(...args),
}));

const mockAccountFindFirst = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findFirst: (...args: unknown[]) => mockAccountFindFirst(...args),
    },
  },
}));

const mockGetGmailToken = jest.fn();
jest.mock("@/lib/gmail", () => ({
  getGmailToken: (...args: unknown[]) => mockGetGmailToken(...args),
}));

import { POST } from "@/app/api/gmail/scan/route";

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
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockAccountFindFirst.mockResolvedValue({ id: "acct-1" });
  mockGetGmailToken.mockResolvedValue("fake-access-token");
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

  it("returns 400 when fromDate is not a valid date string", async () => {
    const res = await POST(makeRequest({ ...validBody, fromDate: "not-a-date" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid.*date/i);
  });

  it("returns 400 when toDate is not a valid date string", async () => {
    const res = await POST(makeRequest({ ...validBody, toDate: "32/13/2099" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid.*date/i);
  });

  it("returns 400 when fromDate is not before toDate", async () => {
    const res = await POST(makeRequest({ ...validBody, fromDate: "2026-12-01", toDate: "2026-01-01" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/before/i);
  });

  it("returns 422 when Gmail token is unavailable (revoked)", async () => {
    mockGetGmailToken.mockResolvedValue(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/token|sign in/i);
  });

  it("returns 400 when gmailQuery is blank after trimming", async () => {
    const res = await POST(makeRequest({ ...validBody, gmailQuery: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/gmailQuery/i);
  });

  it("returns 400 when scanLimit is 0", async () => {
    const res = await POST(makeRequest({ ...validBody, scanLimit: 0 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/scanLimit/i);
  });

  it("returns 400 when scanLimit is negative", async () => {
    const res = await POST(makeRequest({ ...validBody, scanLimit: -5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/scanLimit/i);
  });

  it("returns 400 when scanLimit is a float", async () => {
    const res = await POST(makeRequest({ ...validBody, scanLimit: 1.5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/scanLimit/i);
  });

  it("accepts a valid positive integer scanLimit", async () => {
    const res = await POST(makeRequest({ ...validBody, scanLimit: 100 }));
    expect(res.status).toBe(201);
  });

  it("returns 400 when filterName exceeds 255 characters", async () => {
    const res = await POST(makeRequest({ ...validBody, filterName: "a".repeat(256) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/filterName/i);
  });

  it("accepts a filterName of exactly 255 characters", async () => {
    const res = await POST(makeRequest({ ...validBody, filterName: "a".repeat(255) }));
    expect(res.status).toBe(201);
  });

  it("returns 400 when request body is malformed JSON", async () => {
    const req = new Request("http://localhost/api/gmail/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid.*json|malformed|parse/i);
  });

  it("returns 400 when clientRequestId exceeds 500 characters", async () => {
    const res = await POST(makeRequest({ ...validBody, clientRequestId: "x".repeat(501) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/clientRequestId/i);
  });

  it("accepts a clientRequestId of exactly 500 characters", async () => {
    const res = await POST(makeRequest({ ...validBody, clientRequestId: "x".repeat(500) }));
    expect(res.status).toBe(201);
  });
});
