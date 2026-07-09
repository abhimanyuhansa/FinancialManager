import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const stored = await prisma.statementPassword.findMany({
    where: { userId },
    select: { senderDomain: true, updatedAt: true },
    orderBy: { senderDomain: "asc" },
  });

  const encryptedLogs = await prisma.parseLog.findMany({
    where: { userId, outcome: "skipped_pdf_encrypted" },
    select: { senderDomain: true },
    distinct: ["senderDomain"],
  });
  const storedDomains = new Set(stored.map((s) => s.senderDomain));
  const pendingDomains = encryptedLogs
    .map((l) => l.senderDomain)
    .filter((d) => !storedDomains.has(d));

  return NextResponse.json({
    stored: stored.map((s) => ({ senderDomain: s.senderDomain, updatedAt: s.updatedAt })),
    pending: pendingDomains,
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { senderDomain, password } = (await req.json()) as {
    senderDomain?: string;
    password?: string;
  };

  if (!senderDomain || !password) {
    return NextResponse.json({ error: "senderDomain and password required" }, { status: 400 });
  }

  const encryptedPassword = encrypt(password);

  await prisma.statementPassword.upsert({
    where: { userId_senderDomain: { userId, senderDomain } },
    update: { encryptedPassword },
    create: { userId, senderDomain, encryptedPassword },
  });

  return NextResponse.json({ ok: true });
}
