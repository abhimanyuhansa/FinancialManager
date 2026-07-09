import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ domain: string }> };

export async function DELETE(_req: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { domain } = await params;
  const decodedDomain = decodeURIComponent(domain);

  await prisma.statementPassword.deleteMany({
    where: { userId: session.user.id, senderDomain: decodedDomain },
  });

  return NextResponse.json({ ok: true });
}
