import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const classification = url.searchParams.get("classification");
  const fetchStatus = url.searchParams.get("fetchStatus");
  const cursor = url.searchParams.get("cursor");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

  const rows = await prisma.emailSource.findMany({
    where: {
      userId: session.user.id,
      deletedAt: null,
      ...(classification ? { currentManualClassification: classification } : {}),
      ...(fetchStatus ? { lastFetchStatus: fetchStatus } : {}),
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      subject: true,
      senderName: true,
      senderEmail: true,
      senderDomain: true,
      receivedAt: true,
      hasAttachment: true,
      sourceUrl: true,
      lastFetchStatus: true,
      lastFetchErrorCode: true,
      lastFetchErrorMessageSanitized: true,
      currentManualClassification: true,
      classificationVersion: true,
    },
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return NextResponse.json({
    items,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
  });
}
