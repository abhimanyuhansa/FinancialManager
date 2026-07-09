import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

  const job = await prisma.syncJob.findUnique({
    where: { id: jobId, userId },
    select: {
      status: true,
      totalEmails: true,
      processedEmails: true,
      newTransactions: true,
      skippedEmails: true,
      startedAt: true,
      completedAt: true,
    },
  });

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json({
    status: job.status,
    totalEmails: job.totalEmails,
    processedEmails: job.processedEmails,
    newTransactions: job.newTransactions,
    skippedEmails: job.skippedEmails,
    done: job.status !== "running",
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  });
}
