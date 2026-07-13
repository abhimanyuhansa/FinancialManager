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

  const subCategory = await prisma.subCategory.findUnique({ where: { id } });
  if (!subCategory) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updated = await prisma.subCategory.update({
    where: { id },
    data: { name: name.trim(), icon: icon?.trim() ?? subCategory.icon },
    select: { id: true, slug: true, name: true, icon: true, parentSlug: true, isDefault: true },
  });

  return NextResponse.json({ subCategory: updated });
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const subCategory = await prisma.subCategory.findUnique({ where: { id } });
  if (!subCategory) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (subCategory.isDefault) {
    return NextResponse.json({ error: "Default sub-categories cannot be deleted" }, { status: 403 });
  }

  // Soft-clear: null out any transactions referencing this sub-category
  await prisma.transaction.updateMany({
    where: { userId: session.user.id, subCategory: subCategory.slug },
    data: { subCategory: null },
  });

  await prisma.subCategory.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
