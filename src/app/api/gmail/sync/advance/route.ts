import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken, fetchMessageIdPage, fetchFullMessageBatch, fetchPdfAttachment } from "@/lib/gmail";
import { parseEmailBatch, type BatchInput } from "@/lib/gemini";
import { upsertTransactionV2 } from "@/lib/dedup";
import { lookupAndUpsertMerchant } from "@/lib/merchantMaster";
import { checkGeminiRateLimit, incrementGeminiUsage } from "@/lib/geminiRateLimit";
import { parseEmailStatic } from "@/lib/staticParser";
import { autoLearnVpa, resolveVpa } from "@/lib/vpaLookup";

const CHUNK_SIZE = 25;
const BODY_LIMIT = 1500;

function buildLogBase(
  email: { msgId: string; senderDomain: string; receivedDate: string },
  job: { id: string; userId: string }
) {
  return {
    userId: job.userId,
    syncJobId: job.id,
    gmailMsgId: email.msgId,
    senderDomain: email.senderDomain,
    emailDate: new Date(email.receivedDate),
  };
}

async function advanceJob(job: {
  id: string;
  userId: string;
}): Promise<{
  phase: "running" | "complete" | "rate_limited";
  newTransactions: number;
  processed?: number;
  total?: number;
  source?: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";

  const pending = await prisma.syncJobMessage.findMany({
    where: { syncJobId: job.id, processed: false },
    take: CHUNK_SIZE,
    orderBy: { id: "asc" },
    select: { id: true, gmailMsgId: true },
  });

  if (pending.length === 0) {
    const completedJob = await prisma.syncJob.findUnique({
      where: { id: job.id },
      select: { startedAt: true },
    });
    const watermark = completedJob?.startedAt ?? new Date();
    const completedAt = new Date();

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: "complete", completedAt },
    });
    await prisma.user.update({
      where: { id: job.userId },
      data: { gmailSyncedAt: watermark },
    });
    return { phase: "complete", newTransactions: 0 };
  }

  const accessToken = await getGmailToken(job.userId);
  if (!accessToken) {
    await prisma.syncJob.update({ where: { id: job.id }, data: { status: "failed", completedAt: new Date() } });
    return { phase: "rate_limited", newTransactions: 0, source: "gmail_token" };
  }

  // Fetch all 50 full messages in ONE Gmail Batch API call
  let fetched;
  try {
    fetched = await fetchFullMessageBatch(accessToken, pending.map((p) => p.gmailMsgId));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "GMAIL_RATE_LIMITED") {
      return { phase: "rate_limited", newTransactions: 0, source: "gmail" };
    }
    throw err;
  }

  const fetchedMap = new Map(fetched.map((m) => [m.id, m]));

  // Fetch PDF attachments where needed
  for (const msg of fetched) {
    if (msg.hasPdfAttachment && msg.pdfAttachmentId) {
      const pdfResult = await fetchPdfAttachment(accessToken, msg.id, msg.pdfAttachmentId);
      if (pdfResult.status === "ok") {
        msg.body = (msg.body + "\n\n" + pdfResult.text).trim();
      }
    }
  }

  const exclusionRules = await prisma.exclusionRule.findMany({ where: { isActive: true } });
  const excludedDomains = new Set(
    exclusionRules.filter((r) => r.type === "sender_domain").map((r) => r.value)
  );
  const excludedEmails = new Set(
    exclusionRules.filter((r) => r.type === "sender_email").map((r) => r.value)
  );

  type ProcessableEmail = {
    msgId: string;
    body: string;
    senderName: string;
    senderEmail: string;
    senderDomain: string;
    receivedDate: string;
    subject: string;
    rowId: string;
  };

  const filteredLogs: Array<{
    userId: string; syncJobId: string; gmailMsgId: string; senderDomain: string;
    bodyLengthRaw: number; bodyLengthSent: number; wasTruncated: boolean; batchSize: number; outcome: string;
  }> = [];
  const toProcess: ProcessableEmail[] = [];

  for (const { id: rowId, gmailMsgId } of pending) {
    const msg = fetchedMap.get(gmailMsgId);
    if (!msg) continue;

    const isExcluded =
      excludedDomains.has(msg.senderDomain) || excludedEmails.has(msg.senderEmail);

    if (isExcluded) {
      filteredLogs.push({
        userId: job.userId, syncJobId: job.id, gmailMsgId,
        senderDomain: msg.senderDomain, bodyLengthRaw: msg.body.length,
        bodyLengthSent: 0, wasTruncated: false, batchSize: 1, outcome: "skipped_exclusion",
      });
      continue;
    }

    toProcess.push({
      msgId: gmailMsgId,
      body: msg.body.slice(0, BODY_LIMIT),
      senderName: msg.senderName,
      senderEmail: msg.senderEmail,
      senderDomain: msg.senderDomain,
      receivedDate: msg.receivedDate,
      subject: msg.subject ?? "",
      rowId,
    });
  }

  if (filteredLogs.length > 0) {
    await prisma.parseLog.createMany({ data: filteredLogs });
  }

  let newTransactions = 0;

  if (toProcess.length > 0) {
    // ── Static parser pass ──────────────────────────────────────────────────
    const geminiQueue: typeof toProcess = [];

    for (const email of toProcess) {
      const staticResult = parseEmailStatic({
        body: email.body,
        senderName: email.senderName,
        senderDomain: email.senderDomain,
        senderEmail: email.senderEmail ?? "",
        subject: email.subject ?? "",
        receivedDate: email.receivedDate,
      });

      if (staticResult.outcome === "not_transaction") {
        await prisma.parseLog.create({
          data: {
            ...buildLogBase(email, job),
            outcome: "not_transaction",
            bodyLengthRaw: email.body.length,
            bodyLengthSent: 0,
            wasTruncated: false,
            batchSize: 1,
          },
        });
        continue;
      }

      if (staticResult.outcome === "parsed") {
        for (const tx of staticResult.transactions) {
          // Auto-learn VPA display name from bank alert
          if (tx.vpa && tx.vpaMerchantRaw) {
            await autoLearnVpa(job.userId, tx.vpa, tx.vpaMerchantRaw, tx.category, tx.subCategory);
          }

          // If merchant unknown, try VPA lookup for previously seen addresses
          let resolvedMerchant = tx.merchant;
          let resolvedCategory = tx.category;
          let resolvedSubCategory = tx.subCategory;
          if (tx.merchant === "Unknown" && tx.vpa) {
            const known = await resolveVpa(job.userId, tx.vpa);
            if (known) {
              resolvedMerchant = known.merchantName;
              resolvedCategory = known.category;
              resolvedSubCategory = known.subCategory;
            }
          }

          const { category: masterCategory, subCategory: masterSubCategory } =
            await lookupAndUpsertMerchant(resolvedMerchant, resolvedCategory, resolvedSubCategory, tx.confidence);

          const upsertResult = await upsertTransactionV2(prisma, {
            userId: job.userId,
            gmailMsgId: email.msgId,
            date: new Date(tx.date),
            merchant: resolvedMerchant,
            amount: tx.amount,
            type: tx.type,
            currency: tx.currency,
            category: masterCategory,
            source: "gmail",
            sourceRank: 1,
            confidence: tx.confidence,
            needsReview: tx.needsReview || resolvedMerchant === "Unknown",
            subCategory: masterSubCategory ?? undefined,
            lineItems: undefined,
            // Store VPA in tag field so the user can identify it later from TransactionPanel
            tag: tx.vpa && resolvedMerchant === "Unknown" ? `vpa:${tx.vpa}` : undefined,
          });

          const outcome = upsertResult.action === "inserted" ? "inserted"
            : upsertResult.action === "upgraded" ? "upgraded" : "skipped_duplicate";
          if (outcome === "inserted") newTransactions++;

          await prisma.parseLog.create({
            data: {
              ...buildLogBase(email, job),
              outcome,
              bodyLengthRaw: email.body.length,
              bodyLengthSent: email.body.length,
              wasTruncated: false,
              batchSize: 1,
              geminiConfidence: tx.confidence,
              parsedMerchant: resolvedMerchant,
              parsedAmount: tx.amount,
              transactionId: upsertResult.id,
            },
          });
        }
        continue;
      }

      // outcome === "insufficient_data" → queue for Gemini
      geminiQueue.push(email);
    }

    // ── Gemini fallback (only for insufficient_data emails) ─────────────────
    if (geminiQueue.length > 0) {
      const rateCheck = await checkGeminiRateLimit();
      if (!rateCheck.allowed) {
        return { phase: "rate_limited", newTransactions: 0, source: "gemini" };
      }

      const batchInputs: BatchInput[] = geminiQueue.map((e, idx) => ({
        emailIndex: idx,
        body: e.body,
        senderName: e.senderName,
        fallbackDate: e.receivedDate,
      }));

      const results = await parseEmailBatch(batchInputs, apiKey);
      await incrementGeminiUsage();

      for (const result of results) {
        const email = geminiQueue[result.emailIndex];
        if (!email) continue;

        const logBase = {
          ...buildLogBase(email, job),
          bodyLengthRaw: result.bodyLengthRaw,
          bodyLengthSent: result.bodyLengthSent,
          wasTruncated: result.wasTruncated,
          batchSize: geminiQueue.length,
          ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
        };

        if (result.outcome !== "parsed" || !result.transactions.length) {
          await prisma.parseLog.create({ data: { ...logBase, outcome: result.outcome } });
          continue;
        }

        for (const tx of result.transactions) {
          const { category: resolvedCategory, subCategory: resolvedSubCategory } =
            await lookupAndUpsertMerchant(tx.merchant, tx.category, tx.subCategory ?? null, tx.confidence ?? 0);

          const upsertResult = await upsertTransactionV2(prisma, {
            userId: job.userId, gmailMsgId: email.msgId, date: new Date(tx.date),
            merchant: tx.merchant, amount: tx.amount, type: tx.type,
            currency: tx.currency, category: resolvedCategory, source: "gmail",
            sourceRank: 1, confidence: tx.confidence, needsReview: tx.needsReview,
            subCategory: resolvedSubCategory ?? undefined,
            lineItems: tx.lineItems ?? undefined,
          });

          const outcome = upsertResult.action === "inserted" ? "inserted"
            : upsertResult.action === "upgraded" ? "upgraded" : "skipped_duplicate";
          if (outcome === "inserted") newTransactions++;

          await prisma.parseLog.create({
            data: {
              ...logBase, outcome, geminiConfidence: tx.confidence,
              parsedMerchant: tx.merchant, parsedAmount: tx.amount, transactionId: upsertResult.id,
            },
          });
        }
      }
    }
  }

  await prisma.syncJobMessage.updateMany({
    where: { id: { in: pending.map((p) => p.id) } },
    data: { processed: true },
  });

  const processedCount = await prisma.syncJobMessage.count({ where: { syncJobId: job.id, processed: true } });
  const totalCount = await prisma.syncJobMessage.count({ where: { syncJobId: job.id } });
  const isDone = processedCount >= totalCount;

  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      processedEmails: processedCount,
      newTransactions: { increment: newTransactions },
      ...(isDone ? { status: "complete", completedAt: new Date() } : {}),
    },
  });

  if (isDone) {
    const completedJob = await prisma.syncJob.findUnique({
      where: { id: job.id },
      select: { startedAt: true },
    });
    const watermark = completedJob?.startedAt ?? new Date();
    const completedAt = new Date();
    await prisma.syncJob.update({ where: { id: job.id }, data: { completedAt } });
    await prisma.user.update({ where: { id: job.userId }, data: { gmailSyncedAt: watermark } });
    return { phase: "complete", newTransactions, processed: processedCount, total: totalCount };
  }

  return { phase: "running", newTransactions, processed: processedCount, total: totalCount };
}

export async function GET(req: NextRequest) {
  // Auth: accept valid session (client) OR Bearer token (cron)
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const querySecret = req.nextUrl.searchParams.get("secret");
  const providedToken = bearerToken ?? querySecret;
  const isCron = !!process.env.CRON_SECRET && providedToken === process.env.CRON_SECRET;

  let sessionUserId: string | null = null;
  if (!isCron) {
    const session = await auth();
    sessionUserId = session?.user?.id ?? null;
    if (!sessionUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Scanning phase — advance one page per tick
  const scanFilter = isCron
    ? { status: "scanning" }
    : { status: "scanning", userId: sessionUserId! };

  const scanningJobs = await prisma.syncJob.findMany({
    where: scanFilter,
    select: { id: true, userId: true, gmailQuery: true, scanPageToken: true },
  });

  for (const job of scanningJobs) {
    const accessToken = await getGmailToken(job.userId);
    if (!accessToken) {
      await prisma.syncJob.update({ where: { id: job.id }, data: { status: "failed", completedAt: new Date() } });
      continue;
    }
    const page = await fetchMessageIdPage(accessToken, job.gmailQuery ?? "", job.scanPageToken ?? undefined);
    if (page.messageIds.length > 0) {
      await prisma.syncJobMessage.createMany({
        data: page.messageIds.map((id) => ({ syncJobId: job.id, gmailMsgId: id, processed: false })),
        skipDuplicates: true,
      });
    }
    const totalCount = await prisma.syncJobMessage.count({ where: { syncJobId: job.id } });
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { totalEmails: totalCount, scanPageToken: page.nextPageToken ?? null,
        status: page.nextPageToken ? "scanning" : "running" },
    });
  }

  // Processing phase
  const runFilter = isCron
    ? { status: "running" }
    : { status: "running", userId: sessionUserId! };

  const runningJobs = await prisma.syncJob.findMany({
    where: runFilter,
    orderBy: { startedAt: "asc" },
    select: { id: true, userId: true },
  });

  const results = [];
  for (const job of runningJobs) {
    const result = await advanceJob(job);
    results.push({ jobId: job.id, ...result });
  }

  // Prune old parse logs (cron only)
  if (isCron) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const pruned = await prisma.parseLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return NextResponse.json({ jobs: results, pruned: pruned.count });
  }

  // For client calls: return the current job state for polling
  const jobId = scanningJobs[0]?.id ?? runningJobs[0]?.id;
  if (!jobId) {
    return NextResponse.json({ phase: "idle" });
  }
  const job = await prisma.syncJob.findUnique({
    where: { id: jobId },
    select: { status: true, totalEmails: true, processedEmails: true, newTransactions: true },
  });
  const resultSummary = results[0];
  if (resultSummary?.phase === "rate_limited") {
    return NextResponse.json({ phase: "rate_limited", source: resultSummary.source });
  }
  if (job?.status === "complete") {
    return NextResponse.json({ phase: "complete", newTransactions: job.newTransactions });
  }
  if (job?.status === "scanning") {
    return NextResponse.json({ phase: "scanning", scanned: job.totalEmails });
  }
  return NextResponse.json({
    phase: "running",
    processed: job?.processedEmails ?? 0,
    total: job?.totalEmails ?? 0,
    newTransactions: job?.newTransactions ?? 0,
  });
}
