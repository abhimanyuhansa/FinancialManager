import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

export const authConfig: NextAuthConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/gmail.readonly",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized({ auth, request }) {
      const pathname = request.nextUrl.pathname;
      const isPublic =
        pathname.startsWith("/login") ||
        pathname.startsWith("/api/auth") ||
        // Cron endpoint uses its own bearer token auth, not session
        pathname === "/api/gmail/sync/advance" ||
        // Test-only auth seed: protected by CRON_SECRET + ENABLE_TEST_AUTH_SEED flag
        pathname === "/api/test/auth-seed" ||
        // Health check
        pathname === "/api/health";
      if (isPublic) return true;
      return !!auth?.user;
    },
  },
};
