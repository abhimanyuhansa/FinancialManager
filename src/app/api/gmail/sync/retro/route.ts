import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildGmailQueryFromDB } from "@/lib/gmailQuery";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { period } = (await req.json()) as { period: "1m" | "3m" | "6m" | "12m" };
  if (!period) {
    return NextResponse.json({ error: "period is required" }, { status: 400 });
  }

  // Cancel any in-progress jobs
  await prisma.syncJob.updateMany({
    where: { userId, status: { in: ["scanning", "running"] } },
    data: { status: "cancelled", completedAt: new Date() },
  });

  const months = period === "1m" ? 1 : period === "3m" ? 3 : period === "6m" ? 6 : 12;
  const fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - months);

  const gmailQuery = await buildGmailQueryFromDB(fromDate);

  const job = await prisma.syncJob.create({
    data: {
      userId,
      totalEmails: 0,
      status: "scanning",
      gmailQuery,
      scanPageToken: null,
      isRetrigger: true,
    },
  });

  return NextResponse.json({ jobId: job.id });
}
