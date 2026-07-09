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
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  const where: Prisma.TransactionWhereInput = { userId };
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      where.date.lte = toDate;
    }
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { date: "desc" },
    select: {
      date: true,
      merchant: true,
      amount: true,
      type: true,
      category: true,
      currency: true,
      source: true,
      tag: true,
    },
  });

  const header = "Date,Merchant,Amount,Type,Category,Currency,Source,Tag";
  const rows = transactions.map((tx) => {
    const date = tx.date.toISOString().split("T")[0];
    const escape = (v: string | null | undefined) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [
      date,
      escape(tx.merchant),
      tx.amount.toFixed(2),
      tx.type,
      tx.category,
      tx.currency,
      tx.source,
      escape(tx.tag),
    ].join(",");
  });

  const csv = [header, ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="transactions-${new Date().toISOString().split("T")[0]}.csv"`,
    },
  });
}
