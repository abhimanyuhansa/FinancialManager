import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";

function logAuthError(error: Error): void {
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 6) {
    if (current instanceof Error) {
      console.error(
        `[auth] error[${depth}]: ${current.constructor.name}: ${current.message}`,
      );
      current = (current as Error & { cause?: unknown }).cause;
      depth++;
      continue;
    }

    if (typeof current === "object" && "err" in current) {
      current = (current as { err?: unknown }).err;
      continue;
    }

    break;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  trustHost: true,
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  callbacks: {
    ...authConfig.callbacks,
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async signIn() {
      console.log("[auth] signIn success");
    },
  },
  logger: {
    error: logAuthError,
  },
});
