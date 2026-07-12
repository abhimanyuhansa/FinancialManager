import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const keywords = await prisma.gmailQueryKeyword.findMany({ orderBy: [{ type: "asc" }, { value: "asc" }] });
  return NextResponse.json(keywords);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { type, value } = await req.json() as { type: string; value: string };
  if (!type || !value) return NextResponse.json({ error: "type and value are required" }, { status: 400 });
  const kw = await prisma.gmailQueryKeyword.create({
    data: { type, value: value.toLowerCase().trim(), isDefault: false },
  });
  return NextResponse.json(kw);
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await req.json() as { id: string };
  await prisma.gmailQueryKeyword.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, isActive } = await req.json() as { id: string; isActive: boolean };
  const kw = await prisma.gmailQueryKeyword.update({ where: { id }, data: { isActive } });
  return NextResponse.json(kw);
}
