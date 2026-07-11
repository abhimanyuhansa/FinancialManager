import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const job = await prisma.syncJob.findFirst({
    where: { userId, status: "running" },
    orderBy: { startedAt: "desc" },
  });

  if (!job) {
    return NextResponse.json({ error: "No running job" }, { status: 404 });
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { status: "cancelled", completedAt: new Date() },
  });

  return NextResponse.json({ ok: true, jobId: job.id });
}
