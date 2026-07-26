import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const filter = await prisma.userEmailFilter.findFirst({
    where: { id, userId: session.user.id },
    include: { currentVersion: true },
  });
  if (!filter) {
    return NextResponse.json({ error: "Filter not found" }, { status: 404 });
  }
  return NextResponse.json({ filter });
}

export async function PATCH(request: Request, context: Context) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const data: { name?: string; isActive?: boolean } = {};
  if (body.name !== undefined) {
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 120
    ) {
      return NextResponse.json({ error: "Invalid filter name" }, { status: 400 });
    }
    data.name = body.name.trim();
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return NextResponse.json({ error: "Invalid active state" }, { status: 400 });
    }
    data.isActive = body.isActive;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No changes supplied" }, { status: 400 });
  }
  const { id } = await context.params;
  const updated = await prisma.userEmailFilter.updateMany({
    where: { id, userId: session.user.id },
    data: { ...data, updatedAt: new Date() },
  });
  if (updated.count !== 1) {
    return NextResponse.json({ error: "Filter not found" }, { status: 404 });
  }
  return GET(request, context);
}

export async function DELETE(_request: Request, context: Context) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const updated = await prisma.userEmailFilter.updateMany({
    where: { id, userId: session.user.id },
    data: { isActive: false, updatedAt: new Date() },
  });
  if (updated.count !== 1) {
    return NextResponse.json({ error: "Filter not found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
