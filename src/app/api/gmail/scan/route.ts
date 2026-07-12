import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getGmailToken,
  fetchMessageMetadataList,
  classifySenders,
  buildScanFromDate,
  LookbackPeriod,
} from "@/lib/gmail";
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

  // Paginate through ALL pages — no longer limited to 500
  let allMessages: Awaited<ReturnType<typeof fetchMessageMetadataList>>["messages"] = [];
  let pageToken: string | undefined = undefined;
  do {
    const page = await fetchMessageMetadataList(accessToken, fromDate, pageToken, gmailQuery);
    allMessages = allMessages.concat(page.messages);
    pageToken = page.nextPageToken;
  } while (pageToken);

  console.log(`[scan] fetched ${allMessages.length} messages total after pagination`);

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });
  const scanResult = classifySenders(allMessages, filters);

  const filterValues = new Set(filters.map((f) => f.value));
  for (const s of scanResult.autoApproved) {
    s.existsInFilter = filterValues.has(s.domain) || filterValues.has(s.sender);
  }

  return NextResponse.json({
    period,
    fromDate: fromDate.toISOString(),
    ...scanResult,
  });
}
