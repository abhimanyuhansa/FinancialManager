import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") ?? "";
  const type = searchParams.get("type") ?? ""; // "income" | "expense" | ""
  const category = searchParams.get("category") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const pageSize = 50;

  const where: Prisma.TransactionWhereInput = { userId };
  if (search) {
    where.merchant = { contains: search, mode: "insensitive" };
  }
  if (type === "income" || type === "expense") where.type = type;
  if (category) where.category = category;
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      where.date.lte = toDate;
    }
  }

  const [total, transactions] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where,
      orderBy: { date: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        merchant: true,
        amount: true,
        type: true,
        category: true,
        subCategory: true,
        date: true,
        needsReview: true,
        reviewed: true,
        source: true,
        tag: true,
        gmailMsgId: true,
      },
    }),
  ]);

  return NextResponse.json({ transactions, total, page, pageSize });
}
