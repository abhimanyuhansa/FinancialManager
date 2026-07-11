import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // Cancel any running jobs first
  await prisma.syncJob.updateMany({
    where: { userId, status: "running" },
    data: { status: "cancelled", completedAt: new Date() },
  });

  // Reset watermark so next sync restarts from period picker
  await prisma.user.update({
    where: { id: userId },
    data: { gmailSyncedAt: null },
  });

  const [transactions, syncJobs, parseLogs, assets] = await Promise.all([
    prisma.transaction.deleteMany({ where: { userId } }),
    prisma.syncJob.deleteMany({ where: { userId } }),
    prisma.parseLog.deleteMany({ where: { userId } }),
    prisma.asset.deleteMany({ where: { userId } }),
  ]);

  console.log(`[user/data] DELETE userId=${userId} txns=${transactions.count} jobs=${syncJobs.count} logs=${parseLogs.count} assets=${assets.count}`);

  return NextResponse.json({
    deleted: {
      transactions: transactions.count,
      syncJobs: syncJobs.count,
      parseLogs: parseLogs.count,
      assets: assets.count,
    },
  });
}
