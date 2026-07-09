import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeKpis, computeMonthlyTotals, computeCategoryBreakdown } from "@/lib/analytics";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  console.log(`[analytics/dashboard] userId=${userId}`);

  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const sixMonthTxs = await prisma.transaction.findMany({
    where: { userId, date: { gte: sixMonthsAgo } },
    select: { amount: true, type: true, category: true, date: true },
    orderBy: { date: "desc" },
  });

  const currentMonthTxs = sixMonthTxs.filter((tx) => tx.date >= currentMonthStart);
  const prevMonthTxs = sixMonthTxs.filter(
    (tx) => tx.date >= prevMonthStart && tx.date < currentMonthStart
  );

  const assets = await prisma.asset.findMany({
    where: { userId },
    select: { value: true },
  });
  const assetTotal = assets.reduce((sum, a) => sum + a.value, 0);

  const currentMonth = computeKpis(
    currentMonthTxs.map((tx) => ({ amount: tx.amount, type: tx.type as "income" | "expense" })),
    assetTotal
  );
  const prevMonth = computeKpis(
    prevMonthTxs.map((tx) => ({ amount: tx.amount, type: tx.type as "income" | "expense" })),
    assetTotal
  );

  const monthlyTotals = computeMonthlyTotals(
    sixMonthTxs.map((tx) => ({
      amount: tx.amount,
      type: tx.type as "income" | "expense",
      date: tx.date,
    }))
  );

  const categoryBreakdown = computeCategoryBreakdown(
    currentMonthTxs.map((tx) => ({
      amount: tx.amount,
      type: tx.type as "income" | "expense",
      category: tx.category,
    }))
  );

  const recentTransactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { date: "desc" },
    take: 5,
    select: {
      id: true,
      merchant: true,
      amount: true,
      type: true,
      category: true,
      date: true,
      needsReview: true,
    },
  });

  const needsReviewCount = await prisma.transaction.count({
    where: { userId, needsReview: true, reviewed: false },
  });

  console.log(`[analytics/dashboard] sixMonthTxs=${sixMonthTxs.length} assets=${assets.length} assetTotal=${assetTotal} needsReview=${needsReviewCount}`);

  return NextResponse.json({
    currentMonth,
    prevMonth,
    monthlyTotals,
    categoryBreakdown,
    recentTransactions,
    needsReviewCount,
  });
}
