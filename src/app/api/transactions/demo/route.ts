import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { count } = await prisma.transaction.deleteMany({
    where: { userId: session.user.id, source: "seed" },
  });

  return NextResponse.json({ deleted: count });
}
