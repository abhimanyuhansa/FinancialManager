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
import { buildGmailQuery } from "@/lib/gmailQuery";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  console.log(`[scan] userId=${userId}`);

  const body = (await req.json()) as { period?: LookbackPeriod };
  const period: LookbackPeriod = body.period ?? "6m";

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const fromDate = buildScanFromDate(period);
  console.log(`[scan] period=${period} fromDate=${fromDate.toISOString()}`);

  const gmailQuery = buildGmailQuery(fromDate);
  console.log(`[scan] gmailQuery="${gmailQuery}"`);
  const page = await fetchMessageMetadataList(accessToken, fromDate, undefined, gmailQuery);
  const allMessages = page.messages;
  console.log(`[scan] fetched ${allMessages.length} messages after pre-filter`);

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });
  console.log(`[scan] ${filters.length} active EmailFilters loaded`);

  const scanResult = classifySenders(allMessages, filters);
  console.log(`[scan] autoApproved=${scanResult.autoApproved.length} needsReview=${scanResult.needsReview.length} financialFound=${scanResult.financialFound}`);

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
