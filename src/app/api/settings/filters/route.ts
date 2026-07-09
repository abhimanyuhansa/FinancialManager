import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const filters = await prisma.emailFilter.findMany({
    orderBy: [{ sourceRank: "asc" }, { addedAt: "desc" }],
    select: { id: true, type: true, value: true, sourceRank: true, isActive: true, note: true, addedAt: true },
  });
  return NextResponse.json({ filters });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { type, value, sourceRank, note } = (await req.json()) as {
    type?: string; value?: string; sourceRank?: number; note?: string;
  };
  if (!type || !value) return NextResponse.json({ error: "type and value are required" }, { status: 400 });

  const filter = await prisma.emailFilter.upsert({
    where: { type_value: { type, value } },
    update: { sourceRank: sourceRank ?? 3, note: note ?? null, isActive: true },
    create: { type, value, sourceRank: sourceRank ?? 3, note: note ?? null },
  });
  return NextResponse.json({ filter }, { status: 201 });
}
