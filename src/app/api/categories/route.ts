import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const categories = await prisma.category.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, slug: true, name: true, icon: true, isDefault: true },
  });

  return NextResponse.json({ categories });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, slug, icon } = await req.json() as { name?: string; slug?: string; icon?: string };

  if (!name?.trim() || !slug?.trim()) {
    return NextResponse.json({ error: "name and slug are required" }, { status: 400 });
  }

  const existing = await prisma.category.findUnique({ where: { slug: slug.trim() } });
  if (existing) {
    return NextResponse.json({ error: "A category with this slug already exists" }, { status: 409 });
  }

  const category = await prisma.category.create({
    data: {
      name: name.trim(),
      slug: slug.trim(),
      icon: icon?.trim() ?? "",
      isDefault: false,
      userId: session.user.id,
    },
    select: { id: true, slug: true, name: true, icon: true, isDefault: true },
  });

  return NextResponse.json({ category });
}
