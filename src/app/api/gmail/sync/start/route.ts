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

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { syncFromDate: true },
  });
  if (!user?.syncFromDate) {
    return NextResponse.json({ error: "No syncFromDate set — complete onboarding first" }, { status: 400 });
  }

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });

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

  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: qualifyingIds.length,
      messageIds: JSON.stringify(qualifyingIds),
    },
  });

  return NextResponse.json({ jobId: job.id, totalEmails: qualifyingIds.length });
}
