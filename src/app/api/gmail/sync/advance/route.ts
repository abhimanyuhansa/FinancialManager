import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getGmailToken, fetchPdfAttachment, fetchMessageMetadataList } from "@/lib/gmail";
import { parseEmailBatch, type BatchInput } from "@/lib/gemini";
import { upsertTransactionV2 } from "@/lib/dedup";
import { matchesEmailFilter } from "@/lib/emailFilter";

const CHUNK_SIZE = 15;
const BATCH_SIZE = 10;
const BODY_LIMIT = 1500;

type FetchedMessage = {
  body: string;
  senderName: string;
  senderDomain: string;
  receivedDate: string;
  hasPdfAttachment: boolean;
  pdfOutcome: "ok" | "encrypted" | "failed" | null;
};

async function fetchFullMessage(
  accessToken: string,
  msgId: string
): Promise<FetchedMessage | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;

  const msg = await res.json() as {
    internalDate?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string; attachmentId?: string } }>;
    };
  };

  const headers = msg.payload?.headers ?? [];
  const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
  const senderRaw = get("From");
  const senderName = senderRaw.replace(/<[^>]+>/, "").trim() || senderRaw;
  const emailMatch = senderRaw.match(/<([^>]+)>/);
  const senderEmail = emailMatch ? emailMatch[1] : senderRaw;
  const senderDomain = senderEmail.includes("@") ? senderEmail.split("@")[1] : senderEmail;
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
    body = decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  let hasPdfAttachment = false;
  let pdfOutcome: FetchedMessage["pdfOutcome"] = null;

  const pdfParts = parts.filter((p) => p.mimeType === "application/pdf" && p.body?.attachmentId);
  if (pdfParts.length > 0) {
    hasPdfAttachment = true;
    const part = pdfParts[0];
    const pdfResult = await fetchPdfAttachment(accessToken, msgId, part.body!.attachmentId!);
    if (pdfResult.status === "ok") {
      body = (body + "\n\n" + pdfResult.text).trim();
      pdfOutcome = "ok";
    } else {
      pdfOutcome = pdfResult.status;
    }
  }

  return { body, senderName, senderDomain, receivedDate, hasPdfAttachment, pdfOutcome };
}

async function advanceJob(job: {
  id: string;
  userId: string;
  processedEmails: number;
  messageIds: string | null;
}): Promise<{ newTransactions: number; encryptedBlockedCount: number; completed: boolean }> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const allIds: string[] = job.messageIds ? JSON.parse(job.messageIds) : [];
  const slice = allIds.slice(job.processedEmails, job.processedEmails + CHUNK_SIZE);

  if (slice.length === 0) {
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "complete", completedAt: new Date() },
    });
    return { newTransactions: 0, encryptedBlockedCount: 0, completed: true };
  }

  const accessToken = await getGmailToken(job.userId);
  if (!accessToken) {
    console.error(`[advance] No Gmail token for userId=${job.userId}`);
    return { newTransactions: 0, encryptedBlockedCount: 0, completed: false };
  }

  const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });

  type FetchedEmail = {
    msgId: string;
    body: string;
    senderName: string;
    senderDomain: string;
    receivedDate: string;
    filtered: boolean;
    sourceRank: number;
  };

  const fetched: FetchedEmail[] = [];
  let encryptedBlockedCount = 0;

  for (const msgId of slice) {
    const msg = await fetchFullMessage(accessToken, msgId);
    if (!msg) continue;

    if (msg.hasPdfAttachment && msg.pdfOutcome === "encrypted") {
      await prisma.parseLog.create({
        data: {
          userId: job.userId,
          syncJobId: job.id,
          gmailMsgId: msgId,
          senderDomain: msg.senderDomain,
          bodyLengthRaw: 0,
          bodyLengthSent: 0,
          wasTruncated: false,
          batchSize: 1,
          outcome: "skipped_pdf_encrypted",
        },
      });
      encryptedBlockedCount++;
      continue;
    }

    if (msg.hasPdfAttachment && msg.pdfOutcome === "failed") {
      await prisma.parseLog.create({
        data: {
          userId: job.userId,
          syncJobId: job.id,
          gmailMsgId: msgId,
          senderDomain: msg.senderDomain,
          bodyLengthRaw: 0,
          bodyLengthSent: 0,
          wasTruncated: false,
          batchSize: 1,
          outcome: "skipped_pdf_failed",
        },
      });
      continue;
    }

    const filterResult = matchesEmailFilter({ from: msg.senderName, subject: "" }, filters);
    fetched.push({
      msgId,
      body: msg.body,
      senderName: msg.senderName,
      senderDomain: msg.senderDomain,
      receivedDate: msg.receivedDate,
      filtered: !filterResult.matched,
      sourceRank: filterResult.matched ? filterResult.sourceRank : 3,
    });
  }

  const filteredLogs = fetched.filter((e) => e.filtered).map((e) => ({
    userId: job.userId,
    syncJobId: job.id,
    gmailMsgId: e.msgId,
    senderDomain: e.senderDomain,
    bodyLengthRaw: e.body.length,
    bodyLengthSent: Math.min(e.body.length, BODY_LIMIT),
    wasTruncated: e.body.length > BODY_LIMIT,
    batchSize: 1,
    outcome: "skipped_filter",
  }));
  if (filteredLogs.length > 0) {
    await prisma.parseLog.createMany({ data: filteredLogs });
  }

  const toProcess = fetched.filter((e) => !e.filtered);
  let newTransactions = 0;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const batchInputs: BatchInput[] = batch.map((e, idx) => ({
      emailIndex: idx,
      body: e.body,
      senderName: e.senderName,
      fallbackDate: e.receivedDate,
    }));

    const results = await parseEmailBatch(batchInputs, apiKey);

    for (const result of results) {
      const email = batch[result.emailIndex];
      if (!email) continue;

      const logBase = {
        userId: job.userId,
        syncJobId: job.id,
        gmailMsgId: email.msgId,
        senderDomain: email.senderDomain,
        emailDate: new Date(email.receivedDate),
        bodyLengthRaw: result.bodyLengthRaw,
        bodyLengthSent: result.bodyLengthSent,
        wasTruncated: result.wasTruncated,
        batchSize: batch.length,
      };

      if (result.outcome !== "parsed") {
        await prisma.parseLog.create({ data: { ...logBase, outcome: result.outcome } });
        continue;
      }

      let category = result.category!;
      const merchantKey = result.merchant!.toLowerCase().trim();
      const rule = await prisma.merchantRule.findUnique({
        where: { userId_merchantName: { userId: job.userId, merchantName: merchantKey } },
      });
      if (rule) category = rule.category;

      const upsertResult = await upsertTransactionV2(prisma, {
        userId: job.userId,
        gmailMsgId: email.msgId,
        date: new Date(result.date!),
        merchant: result.merchant!,
        amount: result.amount!,
        type: result.type!,
        currency: result.currency!,
        category,
        source: "gmail",
        sourceRank: email.sourceRank,
        confidence: result.confidence,
        needsReview: result.needsReview,
      });

      const outcome = upsertResult.action === "inserted" ? "inserted"
        : upsertResult.action === "upgraded" ? "upgraded"
        : "skipped_duplicate";

      if (outcome === "inserted") newTransactions++;

      await prisma.parseLog.create({
        data: {
          ...logBase,
          outcome,
          geminiConfidence: result.confidence,
          parsedMerchant: result.merchant,
          parsedAmount: result.amount,
          transactionId: upsertResult.id,
        },
      });
    }
  }

  const processed = job.processedEmails + slice.length;
  const isComplete = processed >= allIds.length;

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      processedEmails: processed,
      newTransactions: { increment: newTransactions },
      encryptedBlockedCount: { increment: encryptedBlockedCount },
      ...(isComplete ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  return { newTransactions, encryptedBlockedCount, completed: isComplete };
}

export async function GET(req: NextRequest) {
  // Vercel Cron sends: Authorization: Bearer <CRON_SECRET>
  // Local dev manual trigger sends: ?secret=<CRON_SECRET> query param
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const querySecret = req.nextUrl.searchParams.get("secret");
  const provided = bearerToken ?? querySecret;

  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Handle jobs in "scanning" phase first — populate messageIds then flip to "running"
  const scanningJobs = await prisma.syncJob.findMany({
    where: { status: "scanning" },
    select: { id: true, userId: true },
  });

  for (const job of scanningJobs) {
    console.log(`[advance] Scanning Gmail for jobId=${job.id}`);
    const accessToken = await getGmailToken(job.userId);
    if (!accessToken) {
      await prisma.syncJob.update({ where: { id: job.id }, data: { status: "failed", completedAt: new Date() } });
      continue;
    }

    const user = await prisma.user.findUnique({ where: { id: job.userId }, select: { syncFromDate: true } });
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const syncFromDate = user?.syncFromDate ?? sixMonthsAgo;

    const filters = await prisma.emailFilter.findMany({ where: { isActive: true } });
    const qualifyingIds: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await fetchMessageMetadataList(accessToken, syncFromDate, pageToken);
      for (const msg of page.messages) {
        const match = matchesEmailFilter(msg, filters);
        if (match.matched) qualifyingIds.push(msg.id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    console.log(`[advance] jobId=${job.id} scan complete: ${qualifyingIds.length} qualifying messages`);
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "running", totalEmails: qualifyingIds.length, messageIds: JSON.stringify(qualifyingIds) },
    });
  }

  const runningJobs = await prisma.syncJob.findMany({
    where: { status: "running" },
    orderBy: { startedAt: "asc" },
    select: { id: true, userId: true, processedEmails: true, messageIds: true },
  });

  console.log(`[advance] Processing ${runningJobs.length} running jobs`);

  const summary: Array<{ jobId: string; newTransactions: number; completed: boolean }> = [];
  for (const job of runningJobs) {
    const result = await advanceJob(job);
    summary.push({ jobId: job.id, newTransactions: result.newTransactions, completed: result.completed });
  }

  // Prune ParseLog rows older than 30 days
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const pruned = await prisma.parseLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  console.log(`[advance] Pruned ${pruned.count} ParseLog rows older than 30 days`);

  return NextResponse.json({ jobs: summary, pruned: pruned.count });
}
