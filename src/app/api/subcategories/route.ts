import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const parent = searchParams.get("parent") ?? "";
  if (!parent) return NextResponse.json({ error: "parent slug is required" }, { status: 400 });

  const subCategories = await prisma.subCategory.findMany({
    where: { parentSlug: parent },
    orderBy: { name: "asc" },
    select: { id: true, slug: true, name: true, icon: true, parentSlug: true, isDefault: true },
  });

  return NextResponse.json({ subCategories });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, parentSlug, icon } = await req.json() as { name?: string; parentSlug?: string; icon?: string };

  if (!name?.trim() || !parentSlug?.trim()) {
    return NextResponse.json({ error: "name and parentSlug are required" }, { status: 400 });
  }

  const parent = await prisma.category.findUnique({ where: { slug: parentSlug.trim() } });
  if (!parent) return NextResponse.json({ error: "Parent category not found" }, { status: 404 });

  const subSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = `${parentSlug.trim()}:${subSlug}`;

  const existing = await prisma.subCategory.findUnique({ where: { slug } });
  if (existing) return NextResponse.json({ error: "A sub-category with this name already exists" }, { status: 409 });

  const subCategory = await prisma.subCategory.create({
    data: {
      name: name.trim(),
      slug,
      icon: icon?.trim() ?? "",
      isDefault: false,
      parentSlug: parentSlug.trim(),
      userId: session.user.id,
    },
    select: { id: true, slug: true, name: true, icon: true, parentSlug: true, isDefault: true },
  });

  return NextResponse.json({ subCategory });
}
