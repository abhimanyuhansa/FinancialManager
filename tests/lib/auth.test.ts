let capturedConfig: Record<string, unknown> = {};

jest.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: jest.fn(() => ({})),
}));
jest.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      updateMany: jest.fn(),
    },
  },
}));
jest.mock("next-auth", () => {
  return jest.fn((config: Record<string, unknown>) => {
    capturedConfig = config;
    return {
      handlers: {},
      auth: jest.fn(),
      signIn: jest.fn(),
      signOut: jest.fn(),
    };
  });
});
jest.mock("next-auth/providers/google", () => jest.fn(() => ({ id: "google" })));

// Import after mocks are set up
import "@/lib/auth";
import { prisma } from "@/lib/prisma";

describe("auth config", () => {
  it("uses database session strategy", () => {
    expect((capturedConfig.session as { strategy: string }).strategy).toBe("database");
  });

  it("has google provider", () => {
    const providers = capturedConfig.providers as Array<{ id: string }>;
    expect(providers.some((p) => p.id === "google")).toBe(true);
  });

  it("redirects sign-in to /login", () => {
    expect((capturedConfig.pages as { signIn: string }).signIn).toBe("/login");
  });

  it("session callback sets user.id", async () => {
    type SessionCallback = (args: {
      session: { user: Record<string, unknown> };
      user: { id: string };
    }) => Promise<unknown>;
    const callbacks = capturedConfig.callbacks as { session: SessionCallback };
    const mockSession = { user: {} as Record<string, unknown> };
    const result = await callbacks.session({ session: mockSession, user: { id: "user-123" } });
    expect((result as typeof mockSession).user).toEqual({ id: "user-123" });
  });

  it("persists fresh Google credentials for an existing account", async () => {
    type SignInCallback = (args: {
      account: {
        provider: string;
        providerAccountId: string;
        access_token?: string;
        refresh_token?: string;
        expires_at?: number;
        token_type?: string;
        scope?: string;
        id_token?: string;
      } | null;
    }) => Promise<boolean>;
    const callbacks = capturedConfig.callbacks as { signIn: SignInCallback };

    await expect(
      callbacks.signIn({
        account: {
          provider: "google",
          providerAccountId: "google-account-1",
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_at: 123456,
          token_type: "bearer",
          scope: "gmail.readonly",
          id_token: "new-id-token",
        },
      }),
    ).resolves.toBe(true);

    expect(prisma.account.updateMany).toHaveBeenCalledWith({
      where: {
        provider: "google",
        providerAccountId: "google-account-1",
      },
      data: {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at: 123456,
        token_type: "bearer",
        scope: "gmail.readonly",
        id_token: "new-id-token",
      },
    });
  });

  it("does not enable Auth.js debug metadata logging", () => {
    expect(capturedConfig.logger).not.toHaveProperty("debug");
  });
});
