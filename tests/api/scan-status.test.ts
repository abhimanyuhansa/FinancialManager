const mockAuth = jest.fn();
jest.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

const mockGetScanProgress = jest.fn();
jest.mock("@/lib/scan/scanProgressService", () => ({
  getScanProgressForUser: (...args: unknown[]) => mockGetScanProgress(...args),
}));

import { GET } from "@/app/api/gmail/scan/[id]/route";

const context = { params: Promise.resolve({ id: "scan-1" }) };

describe("GET /api/gmail/scan/[id]", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 401 without an authenticated database session", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/gmail/scan/scan-1"),
      context,
    );

    expect(response.status).toBe(401);
    expect(mockGetScanProgress).not.toHaveBeenCalled();
  });

  it("does not expose a scan outside the authenticated tenant", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockGetScanProgress.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/gmail/scan/scan-1"),
      context,
    );

    expect(response.status).toBe(404);
    expect(mockGetScanProgress).toHaveBeenCalledWith("user-1", "scan-1");
  });

  it("returns the reconciled scan progress", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockGetScanProgress.mockResolvedValue({
      scanRunId: "scan-1",
      status: "FETCHING",
      cacheMatches: true,
    });

    const response = await GET(
      new Request("http://localhost/api/gmail/scan/scan-1"),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scanRunId: "scan-1",
      status: "FETCHING",
      cacheMatches: true,
    });
  });
});
