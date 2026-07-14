import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/gmail/sync/pause         — pause an active job
// POST /api/gmail/sync/pause?resume  — resume a paused job
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const isResume = req.nextUrl.searchParams.has("resume");

  if (isResume) {
    const job = await prisma.syncJob.findFirst({
      where: { userId, status: "paused" },
      orderBy: { startedAt: "desc" },
    });
    if (!job) return NextResponse.json({ error: "No paused job" }, { status: 404 });

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "running" },
    });
    return NextResponse.json({ ok: true, jobId: job.id, status: "running" });
  }

  const job = await prisma.syncJob.findFirst({
    where: { userId, status: { in: ["scanning", "running"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!job) return NextResponse.json({ error: "No active job" }, { status: 404 });

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { status: "paused" },
  });
  return NextResponse.json({ ok: true, jobId: job.id, status: "paused" });
}
