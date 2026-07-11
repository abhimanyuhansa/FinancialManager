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
    select: { id: true, processedEmails: true, totalEmails: true },
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
    select: { syncFromDate: true },
  });

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const syncFromDate = user?.syncFromDate ?? sixMonthsAgo;

  const gmailQuery = buildGmailQuery(syncFromDate);

  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: 0,
      messageIds: null,
      status: "scanning",
      gmailQuery,
      scanPageToken: null,
    },
  });

  console.log(`[sync/start] created jobId=${job.id} query="${gmailQuery}"`);
  return NextResponse.json({ jobId: job.id });
}
