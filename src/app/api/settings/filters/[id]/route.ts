import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { isActive, sourceRank, note } = (await req.json()) as {
    isActive?: boolean; sourceRank?: number; note?: string;
  };

  const filter = await prisma.emailFilter.update({
    where: { id },
    data: {
      ...(isActive !== undefined && { isActive }),
      ...(sourceRank !== undefined && { sourceRank }),
      ...(note !== undefined && { note }),
    },
  });
  return NextResponse.json({ filter });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  await prisma.emailFilter.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
