import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const subcategories = await prisma.subCategoryMaster.findMany({ orderBy: [{ category: "asc" }, { subCategory: "asc" }] });
  return NextResponse.json(subcategories);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { category, subCategory } = await req.json() as { category: string; subCategory: string };
  if (!category || !subCategory) return NextResponse.json({ error: "category and subCategory are required" }, { status: 400 });
  const entry = await prisma.subCategoryMaster.create({
    data: { category: category.trim(), subCategory: subCategory.trim(), addedBy: "user" },
  });
  return NextResponse.json(entry);
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await req.json() as { id: string };
  const entry = await prisma.subCategoryMaster.findUnique({ where: { id } });
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (entry.addedBy === "system") return NextResponse.json({ error: "Cannot delete system entries" }, { status: 403 });
  await prisma.subCategoryMaster.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
