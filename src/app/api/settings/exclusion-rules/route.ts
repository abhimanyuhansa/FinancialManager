import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rules = await prisma.exclusionRule.findMany({ orderBy: [{ type: "asc" }, { value: "asc" }] });
  return NextResponse.json(rules);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { type, value, note } = await req.json() as { type: string; value: string; note?: string };
  if (!type || !value) return NextResponse.json({ error: "type and value are required" }, { status: 400 });
  const rule = await prisma.exclusionRule.create({
    data: { type, value: value.toLowerCase().trim(), note: note?.trim() || null },
  });
  return NextResponse.json(rule);
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await req.json() as { id: string };
  await prisma.exclusionRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, isActive } = await req.json() as { id: string; isActive: boolean };
  const rule = await prisma.exclusionRule.update({ where: { id }, data: { isActive } });
  return NextResponse.json(rule);
}
