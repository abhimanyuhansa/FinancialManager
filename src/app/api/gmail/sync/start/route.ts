import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken, resolveLegacySyncFromDate, type LookbackPeriod } from "@/lib/gmail";
import { buildGmailQueryFromDB } from "@/lib/gmailQuery";
import { isLegacyTransactionIngestionEnabled } from "@/lib/featureFlags";

export async function POST(req: Request) {
  if (!isLegacyTransactionIngestionEnabled()) {
    return NextResponse.json({ error: "legacy_ingestion_disabled" }, { status: 503 });
  }

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

  const body = await req.json().catch(() => ({})) as { period?: LookbackPeriod };

  const { fromDate, persistSelectedStart } = resolveLegacySyncFromDate(
    {
      gmailSyncedAt: user?.gmailSyncedAt ?? null,
      syncFromDate: user?.syncFromDate ?? null,
    },
    body.period,
  );
  if (persistSelectedStart) {
    await prisma.user.update({
      where: { id: userId },
      data: { syncFromDate: fromDate },
    });
  }

  const gmailQuery = await buildGmailQueryFromDB(fromDate);

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
