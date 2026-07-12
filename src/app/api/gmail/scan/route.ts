import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGmailToken, fetchMessageIdPage, buildScanFromDate, LookbackPeriod } from "@/lib/gmail";
import { buildGmailQueryFromDB } from "@/lib/gmailQuery";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await req.json()) as { period?: LookbackPeriod };
  const period: LookbackPeriod = body.period ?? "6m";

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const fromDate = buildScanFromDate(period);
  const gmailQuery = await buildGmailQueryFromDB(fromDate);

  let totalCount = 0;
  let pageToken: string | undefined = undefined;
  do {
    const page = await fetchMessageIdPage(accessToken, gmailQuery, pageToken);
    totalCount += page.messageIds.length;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);

  return NextResponse.json({ period, fromDate: fromDate.toISOString(), totalCount });
}
