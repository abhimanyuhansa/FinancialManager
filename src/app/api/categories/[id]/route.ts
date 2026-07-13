import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { name, icon } = await req.json() as { name?: string; icon?: string };

  if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updated = await prisma.category.update({
    where: { id },
    data: { name: name.trim(), icon: icon?.trim() ?? category.icon },
    select: { id: true, slug: true, name: true, icon: true, isDefault: true },
  });

  return NextResponse.json({ category: updated });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (category.isDefault) {
    return NextResponse.json({ error: "Default categories cannot be deleted" }, { status: 403 });
  }

  const txCount = await prisma.transaction.count({ where: { userId: session.user.id, category: category.slug } });
  if (txCount > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${txCount} transaction${txCount !== 1 ? "s" : ""} use this category` },
      { status: 409 }
    );
  }

  await prisma.category.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
