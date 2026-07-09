import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken, fetchMessageMetadataList } from "@/lib/gmail";
import { matchesEmailFilter } from "@/lib/emailFilter";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  console.log(`[sync/start] userId=${userId}`);

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { syncFromDate: true },
  });
  if (!user?.syncFromDate) {
    console.warn(`[sync/start] No syncFromDate for userId=${userId}`);
    return NextResponse.json({ error: "No syncFromDate set — complete onboarding first" }, { status: 400 });
  }
  console.log(`[sync/start] Scanning from ${user.syncFromDate.toISOString()}`);

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });
  console.log(`[sync/start] Loaded ${filters.length} active EmailFilters`);

  const qualifyingIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await fetchMessageMetadataList(accessToken, user.syncFromDate, pageToken);
    for (const msg of page.messages) {
      const match = matchesEmailFilter(msg, filters);
      if (match.matched) qualifyingIds.push(msg.id);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  console.log(`[sync/start] ${qualifyingIds.length} qualifying messages found`);

  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: qualifyingIds.length,
      messageIds: JSON.stringify(qualifyingIds),
    },
  });
  console.log(`[sync/start] SyncJob created: jobId=${job.id}`);

  return NextResponse.json({ jobId: job.id, totalEmails: qualifyingIds.length });
}
