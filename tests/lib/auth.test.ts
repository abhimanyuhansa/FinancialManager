let capturedConfig: Record<string, unknown> = {};

jest.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: jest.fn(() => ({})),
}));
jest.mock("@/lib/prisma", () => ({ prisma: {} }));
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
    const callbacks = capturedConfig.callbacks as Record<string, Function>;
    const mockSession = { user: {} as Record<string, unknown> };
    const result = await callbacks.session({ session: mockSession, user: { id: "user-123" } });
    expect((result as typeof mockSession).user).toEqual({ id: "user-123" });
  });
});
