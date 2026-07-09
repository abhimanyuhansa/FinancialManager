import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { parseEmailTransaction } from "@/lib/gemini";
import { upsertTransaction } from "@/lib/dedup";
import { matchesEmailFilter } from "@/lib/emailFilter";

const CHUNK_SIZE = 15;

async function fetchFullMessage(
  accessToken: string,
  msgId: string
): Promise<{ body: string; senderName: string; receivedDate: string } | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;

  const msg = await res.json() as {
    id: string;
    internalDate?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    };
  };

  const headers = msg.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
  const senderRaw = get("From");
  const senderName = senderRaw.replace(/<[^>]+>/, "").trim() || senderRaw;
  const receivedDate = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  let body = "";
  const parts = msg.payload?.parts ?? [];
  const plainPart = parts.find((p) => p.mimeType === "text/plain");
  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  const rawData = plainPart?.body?.data ?? htmlPart?.body?.data ?? msg.payload?.body?.data ?? "";
  if (rawData) {
    const decoded = Buffer.from(rawData, "base64url").toString("utf-8");
    body = decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
  }

  return { body, senderName, receivedDate };
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { jobId } = (await req.json()) as { jobId: string };
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });

  const job = await prisma.syncJob.findUnique({ where: { id: jobId, userId } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "running") {
    return NextResponse.json({ done: true, status: job.status });
  }

  const allIds: string[] = job.messageIds ? JSON.parse(job.messageIds) : [];
  const slice = allIds.slice(job.processedEmails, job.processedEmails + CHUNK_SIZE);
  console.log(`[sync/chunk] jobId=${jobId} processed=${job.processedEmails}/${allIds.length} chunk=${slice.length}`);

  if (slice.length === 0) {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: { status: "complete", completedAt: new Date() },
    });
    console.log(`[sync/chunk] jobId=${jobId} complete (no remaining messages)`);
    return NextResponse.json({ done: true, processed: 0, newTransactions: 0 });
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    await prisma.syncJob.update({ where: { id: jobId }, data: { status: "failed" } });
    return NextResponse.json({ error: "No Gmail token" }, { status: 401 });
  }

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) console.warn(`[sync/chunk] GEMINI_API_KEY not set — Gemini calls will fail`);

  let newTransactions = 0;
  let skipped = 0;

  for (const msgId of slice) {
    const full = await fetchFullMessage(accessToken, msgId);
    if (!full || !full.body) {
      console.log(`[sync/chunk] msgId=${msgId} skipped: no body`);
      skipped++;
      continue;
    }

    const sourceRankMatch = matchesEmailFilter(
      { from: full.senderName, subject: "" },
      filters
    );
    const sourceRank = sourceRankMatch.matched ? sourceRankMatch.sourceRank : 3;

    const parsed = await parseEmailTransaction({
      body: full.body,
      senderName: full.senderName,
      fallbackDate: full.receivedDate,
      apiKey,
    });

    if (!parsed) {
      console.log(`[sync/chunk] msgId=${msgId} skipped: Gemini returned null`);
      skipped++;
      continue;
    }

    const result = await upsertTransaction(prisma, userId, {
      gmailMsgId: msgId,
      parsed,
      sourceRank,
    });

    if (result === "inserted" || result === "upgraded") newTransactions++;
    else skipped++;
  }

  const newProcessed = job.processedEmails + slice.length;
  const done = newProcessed >= allIds.length;
  console.log(`[sync/chunk] jobId=${jobId} chunk done: newTransactions=${newTransactions} skipped=${skipped} done=${done}`);

  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      processedEmails: newProcessed,
      newTransactions: { increment: newTransactions },
      skippedEmails: { increment: skipped },
      ...(done ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  return NextResponse.json({ done, processed: slice.length, newTransactions });
}
