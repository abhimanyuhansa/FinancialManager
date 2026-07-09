import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";

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
    async signIn({ user }) {
      console.log(`[auth] signIn success: userId=${user.id} email=${user.email}`);
    },
  },
  logger: {
    error(error) {
      let e: unknown = error;
      let depth = 0;
      while (e instanceof Error && depth < 6) {
        console.error(`[auth] error[${depth}]: ${e.constructor.name}: ${e.message}`);
        if (depth === 0) console.error(`[auth] stack:`, (e as Error).stack);
        e = (e as Error & { cause?: unknown }).cause;
        depth++;
      }
      if (e !== undefined && e !== null) {
        console.error(`[auth] root cause:`, e);
      }
    },
    debug(message, metadata) {
      console.log(`[auth][debug] ${message}`, JSON.stringify(metadata ?? {}));
    },
  },
});
