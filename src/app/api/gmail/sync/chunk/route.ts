import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { parseEmailBatch, type BatchInput } from "@/lib/gemini";
import { upsertTransactionV2 } from "@/lib/dedup";
import { matchesEmailFilter } from "@/lib/emailFilter";

const CHUNK_SIZE = 15;
const BATCH_SIZE = 10;
const BODY_LIMIT = 1500;

async function fetchFullMessage(
  accessToken: string,
  msgId: string
): Promise<{ body: string; senderName: string; senderDomain: string; receivedDate: string } | null> {
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

  return { body, senderName, senderDomain, receivedDate };
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

  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const allIds: string[] = job.messageIds ? JSON.parse(job.messageIds) : [];
  const slice = allIds.slice(job.processedEmails, job.processedEmails + CHUNK_SIZE);
  console.log(`[sync/chunk] jobId=${jobId} processed=${job.processedEmails}/${allIds.length} chunk=${slice.length}`);

  if (slice.length === 0) {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: { status: "complete", completedAt: new Date() },
    });
    return NextResponse.json({ done: true, processed: 0, newTransactions: 0 });
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    await prisma.syncJob.update({ where: { id: jobId }, data: { status: "failed" } });
    return NextResponse.json({ error: "No Gmail token" }, { status: 401 });
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
  for (const msgId of slice) {
    const msg = await fetchFullMessage(accessToken, msgId);
    if (!msg) continue;

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

  // Write ParseLog for filtered emails
  const filteredLogs = fetched
    .filter((e) => e.filtered)
    .map((e) => ({
      userId,
      syncJobId: jobId,
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
  let skipped = 0;

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
        userId,
        syncJobId: jobId,
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
        skipped++;
        continue;
      }

      // Apply MerchantRule override
      let category = result.category!;
      const merchantKey = result.merchant!.toLowerCase().trim();
      const rule = await prisma.merchantRule.findUnique({
        where: { userId_merchantName: { userId, merchantName: merchantKey } },
      });
      if (rule) {
        console.log(`[sync/chunk] MerchantRule: ${merchantKey} -> ${rule.category}`);
        category = rule.category;
      }

      const upsertResult = await upsertTransactionV2(prisma, {
        userId,
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
      else skipped++;

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
    where: { id: jobId },
    data: {
      processedEmails: processed,
      newTransactions: { increment: newTransactions },
      skippedEmails: { increment: skipped },
      ...(isComplete ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  console.log(`[sync/chunk] jobId=${jobId} done. new=${newTransactions} skipped=${skipped} processed=${processed}/${allIds.length}`);
  return NextResponse.json({
    done: isComplete,
    processed: slice.length,
    newTransactions,
    totalProcessed: processed,
    total: allIds.length,
  });
}
