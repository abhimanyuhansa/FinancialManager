import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const outcome = searchParams.get("outcome") ?? "";
  const domain = searchParams.get("domain") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  const where: Prisma.ParseLogWhereInput = { userId };
  if (outcome) where.outcome = outcome;
  if (domain) where.senderDomain = { contains: domain, mode: "insensitive" };
  if (from || to) {
    where.createdAt = {};
    if (from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      (where.createdAt as Prisma.DateTimeFilter).lte = toDate;
    }
  }

  const [total, logs] = await Promise.all([
    prisma.parseLog.count({ where }),
    prisma.parseLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        gmailMsgId: true,
        senderDomain: true,
        emailDate: true,
        outcome: true,
        geminiConfidence: true,
        parsedMerchant: true,
        parsedAmount: true,
        wasTruncated: true,
        bodyLengthRaw: true,
        bodyLengthSent: true,
        transactionId: true,
        createdAt: true,
      },
    }),
  ]);

  return NextResponse.json({ logs, total, page, pageSize: PAGE_SIZE });
}
