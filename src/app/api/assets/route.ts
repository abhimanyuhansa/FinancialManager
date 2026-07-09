import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const assets = await prisma.asset.findMany({
    where: { userId: session.user.id },
    orderBy: { asOf: "desc" },
    select: { id: true, name: true, type: true, value: true, currency: true, asOf: true },
  });
  return NextResponse.json({ assets });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { name, type, value, currency, asOf } = (await req.json()) as {
    name?: string; type?: string; value?: number; currency?: string; asOf?: string;
  };
  if (!name || !type || typeof value !== "number" || !asOf) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  const asset = await prisma.asset.create({
    data: {
      userId: session.user.id,
      name,
      type,
      value,
      currency: currency ?? "INR",
      asOf: new Date(asOf),
    },
  });
  return NextResponse.json({ asset }, { status: 201 });
}
