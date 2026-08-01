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
