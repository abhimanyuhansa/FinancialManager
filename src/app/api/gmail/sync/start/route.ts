import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  console.log(`[sync/start] userId=${userId}`);

  const existingJob = await prisma.syncJob.findFirst({
    where: { userId, status: "running" },
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

  // Create the job immediately with status "scanning" so the UI can show progress.
  // The advance route will do the actual Gmail metadata scan and populate messageIds.
  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: 0,
      messageIds: null,
      status: "scanning",
    },
  });
  console.log(`[sync/start] SyncJob created: jobId=${job.id} (scanning phase)`);

  return NextResponse.json({ jobId: job.id });
}
