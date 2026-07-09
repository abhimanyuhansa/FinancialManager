import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = await prisma.syncJob.findFirst({
    where: { userId: session.user.id },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      totalEmails: true,
      processedEmails: true,
      newTransactions: true,
      encryptedBlockedCount: true,
      startedAt: true,
      completedAt: true,
    },
  });

  if (!job) {
    return NextResponse.json(null);
  }

  return NextResponse.json(job);
}
