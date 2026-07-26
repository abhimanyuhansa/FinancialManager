import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  });
  return new PrismaClient({
    adapter,
    // Temporary compatibility for the live MVP database. These nullable fields
    // belong to the pending Phase 1A schema and are not used by the legacy Gmail
    // flow. Omitting them prevents Auth.js adapter reads from selecting columns
    // that do not exist until the additive Phase 1A migration is approved.
    omit: {
      account: {
        disconnectedAt: true,
        disconnectionReason: true,
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
