const mockAuth = jest.fn();
jest.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

const mockFindMany = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: {
    emailSource: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));

import { GET } from "@/app/api/gmail/email/list/route";

describe("GET /api/gmail/email/list", () => {
  beforeEach(() => jest.clearAllMocks());

  it("requires a database-backed authenticated session", async () => {
    mockAuth.mockResolvedValue(null);
    const response = await GET(
      new Request("http://localhost/api/gmail/email/list"),
    );
    expect(response.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("always scopes inventory reads to the authenticated user", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } });
    mockFindMany.mockResolvedValue([]);
    const response = await GET(
      new Request("http://localhost/api/gmail/email/list?limit=500"),
    );
    expect(response.status).toBe(200);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", deletedAt: null }),
        take: 101,
      }),
    );
  });
});
