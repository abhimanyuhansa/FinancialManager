jest.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findFirst: jest.fn(),
    },
  },
}));
jest.mock("@/lib/auth", () => ({
  auth: jest.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { getGmailToken } from "@/lib/gmail";

const mockAuth = auth as jest.MockedFunction<typeof auth>;
const mockFindFirst = prisma.account.findFirst as jest.MockedFunction<typeof prisma.account.findFirst>;

describe("getGmailToken", () => {
  it("returns access_token when session and account exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "a@b.com" } } as never);
    mockFindFirst.mockResolvedValue({ access_token: "token-abc" } as never);

    const token = await getGmailToken("user-1");
    expect(token).toBe("token-abc");
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", provider: "google" },
      select: { access_token: true },
    });
  });

  it("returns null when no account found", async () => {
    mockFindFirst.mockResolvedValue(null);
    const token = await getGmailToken("user-1");
    expect(token).toBeNull();
  });
});
