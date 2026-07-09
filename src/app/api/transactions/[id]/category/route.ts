import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const { category, scope } = (await req.json()) as {
    category?: string;
    scope?: "single" | "all_merchant";
  };

  if (!category || !scope || !["single", "all_merchant"].includes(scope)) {
    return NextResponse.json({ error: "Invalid request: category and scope required" }, { status: 400 });
  }

  const tx = await prisma.transaction.findUnique({
    where: { id },
    select: { id: true, userId: true, merchant: true },
  });

  if (!tx || tx.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (scope === "single") {
    await prisma.transaction.update({
      where: { id },
      data: { category },
    });
    return NextResponse.json({ updatedCount: 1 });
  }

  // scope === "all_merchant"
  const merchantKey = tx.merchant.toLowerCase().trim();

  const { count } = await prisma.transaction.updateMany({
    where: { userId, merchant: merchantKey },
    data: { category },
  });

  await prisma.merchantRule.upsert({
    where: { userId_merchantName: { userId, merchantName: merchantKey } },
    update: { category },
    create: { userId, merchantName: merchantKey, category },
  });

  return NextResponse.json({ updatedCount: count });
}
