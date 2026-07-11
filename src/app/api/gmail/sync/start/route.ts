import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { buildGmailQuery } from "@/lib/gmailQuery";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const existingJob = await prisma.syncJob.findFirst({
    where: { userId, status: { in: ["scanning", "running"] } },
    select: { id: true },
  });
  if (existingJob) {
    return NextResponse.json(
      { error: "A sync is already in progress", jobId: existingJob.id, running: true },
      { status: 409 }
    );
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { syncFromDate: true, gmailSyncedAt: true },
  });

  let fromDate: Date;
  if (user?.gmailSyncedAt) {
    // Incremental sync: start from watermark - 24h to catch delayed emails
    fromDate = new Date(user.gmailSyncedAt.getTime() - 24 * 60 * 60 * 1000);
  } else {
    // First sync: use the period the user selected during onboarding (or default 6m)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    fromDate = user?.syncFromDate ?? sixMonthsAgo;
  }

  const gmailQuery = buildGmailQuery(fromDate);

  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: 0,
      status: "scanning",
      gmailQuery,
      scanPageToken: null,
    },
  });

  console.log(`[sync/start] userId=${userId} jobId=${job.id} fromDate=${fromDate.toISOString()} incremental=${!!user?.gmailSyncedAt}`);
  return NextResponse.json({ jobId: job.id });
}
