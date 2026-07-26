import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { sourceId } = await context.params;
  const source = await prisma.emailSource.findFirst({
    where: { id: sourceId, userId: session.user.id, deletedAt: null },
    include: {
      classifications: {
        orderBy: { classificationVersion: "desc" },
        select: {
          previousClassification: true,
          newClassification: true,
          reason: true,
          classificationVersion: true,
          classifiedAt: true,
        },
      },
    },
  });
  return source
    ? NextResponse.json({ source })
    : NextResponse.json({ error: "Email source not found" }, { status: 404 });
}
