import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [classification, fetchStatus] = await Promise.all([
    prisma.emailSource.groupBy({
      by: ["currentManualClassification"],
      where: { userId: session.user.id, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.emailSource.groupBy({
      by: ["lastFetchStatus"],
      where: { userId: session.user.id, deletedAt: null },
      _count: { _all: true },
    }),
  ]);
  return NextResponse.json({
    classification: Object.fromEntries(
      classification.map((row) => [row.currentManualClassification, row._count._all]),
    ),
    fetchStatus: Object.fromEntries(
      fetchStatus.map((row) => [row.lastFetchStatus, row._count._all]),
    ),
  });
}
