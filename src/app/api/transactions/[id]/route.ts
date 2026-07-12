// src/app/api/transactions/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { labelVpaByUser } from "@/lib/vpaLookup";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const body = await req.json() as {
    merchant?: string;
    category?: string;
    subCategory?: string;
    vpa?: string;
    scope?: "single" | "all_vpa";
  };

  const tx = await prisma.transaction.findUnique({
    where: { id },
    select: { userId: true, tag: true },
  });
  if (!tx || tx.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Retroactive VPA labeling — applies to all transactions with this VPA
  if (body.vpa && body.merchant && body.category && body.scope === "all_vpa") {
    const result = await labelVpaByUser(
      session.user.id, body.vpa, body.merchant, body.category, body.subCategory ?? null
    );
    return NextResponse.json({ ok: true, updatedTransactions: result.updatedTransactions });
  }

  // Single transaction update
  const updated = await prisma.transaction.update({
    where: { id },
    data: {
      ...(body.merchant    ? { merchant: body.merchant } : {}),
      ...(body.category    ? { category: body.category } : {}),
      ...(body.subCategory ? { subCategory: body.subCategory } : {}),
      needsReview: false,
      reviewed: true,
    },
    select: { id: true, merchant: true, category: true, subCategory: true },
  });

  return NextResponse.json({ ok: true, transaction: updated });
}
