import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getGmailToken, fetchMessageIdPage, fetchFullMessageBatch, fetchPdfAttachment } from "@/lib/gmail";
import { parseEmailBatchLLM } from "@/lib/llm";

export const maxDuration = 60;
import { acquireLock, LockLostError } from "@/lib/llm/lock";
import { upsertTransactionV2 } from "@/lib/dedup";
import { lookupAndUpsertMerchant } from "@/lib/merchantMaster";
import { parseEmailStatic } from "@/lib/staticParser";
import { createHash } from "crypto";
import { autoLearnVpa, resolveVpa } from "@/lib/vpaLookup";
import {
  templateHash, preloadTemplates, warmCacheKey, applyTemplate, compareOutputs,
  deriveExtractors, upsertTemplate, recordHit, recordShadowAgreement,
  recordShadowDisagreement, recordActiveFailure, type ParseTemplateRow,
} from "@/lib/parseTemplateCache";
import { lookupExactCache } from "@/lib/exactResultCache";

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
  const lock = await acquireLock(job.id).catch(() => null);
  if (!lock) {
    // Another instance is actively processing — return current progress so the
    // banner shows a normal progress bar rather than a spurious rate-limit warning.
    const current = await prisma.syncJob.findUnique({
      where: { id: job.id },
      select: { processedEmails: true, totalEmails: true, newTransactions: true },
    });
    return {
      phase: "running",
      newTransactions: current?.newTransactions ?? 0,
      processed: current?.processedEmails ?? 0,
      total: current?.totalEmails ?? 0,
    };
  }

  try {
    return await advanceJobLocked(job, lock);
  } finally {
    lock.release();
  }
}

async function advanceJobLocked(
  job: { id: string; userId: string },
  lock: { lockLost: { value: boolean }; release: () => void }
): Promise<{
  phase: "running" | "complete" | "rate_limited";
  newTransactions: number;
  processed?: number;
  total?: number;
  source?: string;
}> {
  // maxDuration=60 — reserve 8s for DB writes, so LLM gets at most 52s from now.
  const invocationDeadlineMs = Date.now() + 52_000;

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
    parsedMerchant?: string;
  }> = [];
  const toProcess: ProcessableEmail[] = [];
  // REL-8: row IDs for messages Gmail did not return — excluded from processed=true
  // so the next tick can retry them rather than silently losing them.
  const missingRowIds = new Set<string>();

  for (const { id: rowId, gmailMsgId } of pending) {
    const msg = fetchedMap.get(gmailMsgId);
    if (!msg) {
      filteredLogs.push({
        userId: job.userId, syncJobId: job.id, gmailMsgId,
        senderDomain: "unknown", bodyLengthRaw: 0,
        bodyLengthSent: 0, wasTruncated: false, batchSize: 1,
        outcome: "error",
        parsedMerchant: "Gmail batch: message not returned",
      });
      missingRowIds.add(rowId);
      continue;
    }

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
  // Batch ParseLog writes — flushed once after all serial DB work completes,
  // avoiding dozens of individual round-trips before the LLM call.
  const pendingLogs: Prisma.ParseLogCreateManyInput[] = [];
  // Row IDs whose LLM call failed transiently — leave unprocessed so the next
  // tick retries them instead of silently dropping the emails.
  const llmFailedRowIds = new Set<string>();

  if (toProcess.length > 0) {
    // ── Static parser pass ──────────────────────────────────────────────────
    const llmQueue: typeof toProcess = [];

    for (const email of toProcess) {
      if (lock.lockLost.value) throw new LockLostError(job.id);
      const staticResult = parseEmailStatic({
        body: email.body,
        senderName: email.senderName,
        senderDomain: email.senderDomain,
        senderEmail: email.senderEmail ?? "",
        subject: email.subject ?? "",
        receivedDate: email.receivedDate,
      });

      if (staticResult.outcome === "not_transaction") {
        pendingLogs.push({
          ...buildLogBase(email, job),
          outcome: "not_transaction",
          bodyLengthRaw: email.body.length,
          bodyLengthSent: 0,
          wasTruncated: false,
          batchSize: 1,
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

          pendingLogs.push({
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
          });
        }
        continue;
      }

      // outcome === "insufficient_data" → queue for three-tier chain
      llmQueue.push(email);
    }

    // ── Three-tier chain (Tier 1: exact cache → Tier 2: template → Tier 3: LLM) ─
    if (llmQueue.length > 0) {
      // Tier 1: exact result cache — re-use a previously parsed result for the same Gmail message
      const exactHits = await lookupExactCache(job.userId, llmQueue.map((e) => e.msgId));
      const templateQueue: typeof llmQueue = [];
      for (const email of llmQueue) {
        const cachedTxId = exactHits.get(email.msgId);
        if (cachedTxId) {
          pendingLogs.push({
            ...buildLogBase(email, job),
            outcome: "skipped_duplicate",
            bodyLengthRaw: email.body.length,
            bodyLengthSent: 0,
            wasTruncated: false,
            batchSize: 1,
            transactionId: cachedTxId,
            resolvedBy: "exact_cache",
          });
          continue;
        }
        templateQueue.push(email);
      }

      if (templateQueue.length === 0) {
        // all resolved by exact cache — fall through to batch mark-processed
      } else {
        // Tier 2: template cache — try learned regex extractors
        const templateKeys = templateQueue.map((e) => ({
          userId: job.userId,
          senderDomain: e.senderDomain,
          hash: templateHash(e.subject, e.body),
        }));
        const templateMap = await preloadTemplates(templateKeys);
        const invocationMap = new Map<string, ParseTemplateRow>(templateMap);

        const llmCandidates: typeof templateQueue = [];

        for (const email of templateQueue) {
          const hash = templateHash(email.subject, email.body);
          const key = warmCacheKey(job.userId, email.senderDomain, hash);
          const tmpl = invocationMap.get(key);

          if (!tmpl || tmpl.status === "DISABLED") {
            llmCandidates.push(email);
            continue;
          }

          const applied = applyTemplate(email.body, tmpl.extractors);
          if (!applied) {
            // Template failed to extract required fields
            if (tmpl.status === "ACTIVE") {
              await recordActiveFailure(tmpl.id, key, invocationMap);
            } else {
              await recordShadowDisagreement(tmpl.id, key, tmpl.status, invocationMap);
            }
            llmCandidates.push(email);
            continue;
          }

          if (tmpl.status === "ACTIVE") {
            // Use template result directly
            const { category: resolvedCategory, subCategory: resolvedSubCategory } =
              await lookupAndUpsertMerchant(applied.merchant ?? email.senderName, applied.transactionType === "income" ? "income" : "other", null, 0.9);

            const upsertResult = await upsertTransactionV2(prisma, {
              userId: job.userId, gmailMsgId: email.msgId,
              date: new Date(applied.date), merchant: applied.merchant ?? email.senderName,
              amount: applied.amount, type: applied.transactionType,
              currency: applied.currency, category: resolvedCategory,
              source: "gmail", sourceRank: 1, confidence: 0.9, needsReview: false,
              subCategory: resolvedSubCategory ?? undefined,
            });

            const outcome = upsertResult.action === "inserted" ? "inserted"
              : upsertResult.action === "upgraded" ? "upgraded" : "skipped_duplicate";
            if (outcome === "inserted") newTransactions++;

            pendingLogs.push({
              ...buildLogBase(email, job),
              outcome,
              bodyLengthRaw: email.body.length,
              bodyLengthSent: email.body.length,
              wasTruncated: false,
              batchSize: 1,
              geminiConfidence: 0.9,
              parsedMerchant: applied.merchant ?? email.senderName,
              parsedAmount: applied.amount,
              transactionId: upsertResult.id,
              resolvedBy: "template",
            });

            await recordHit(tmpl.id, key, invocationMap);
          } else {
            // SHADOW or DEGRADED — LLM still runs, compare result
            llmCandidates.push(email);
            // shadow applied result stored on email for comparison after Gemini
            (email as typeof email & { _shadowApplied?: typeof applied; _shadowKey?: string; _shadowTmplId?: string; _shadowTmplStatus?: string })._shadowApplied = applied;
            (email as typeof email & { _shadowKey?: string })._shadowKey = key;
            (email as typeof email & { _shadowTmplId?: string })._shadowTmplId = tmpl.id;
            (email as typeof email & { _shadowTmplStatus?: string })._shadowTmplStatus = tmpl.status;
          }
        }

        // Tier 3: LLM fallback for emails that need it (includes shadow runs)
        if (llmCandidates.length > 0) {
          if (lock.lockLost.value) throw new LockLostError(job.id);
          const batchKey = createHash("sha256")
            .update(`${job.userId}:sync:v1:${llmCandidates.map((e) => e.msgId).sort().join(",")}`)
            .digest("hex");
          const llmContext = { userId: job.userId, syncJobId: job.id, operationType: "sync" as const };

          let results: Awaited<ReturnType<typeof parseEmailBatchLLM>>;
          try {
            results = await parseEmailBatchLLM(
              llmCandidates.map((e, idx) => ({
                emailIndex: idx,
                body: e.body,
                senderName: e.senderName,
                fallbackDate: e.receivedDate,
              })),
              batchKey,
              llmContext,
              invocationDeadlineMs
            );
          } catch (llmErr) {
            // LLM batch failed entirely (both providers exhausted or contract error).
            // Log the error but do NOT mark these messages as processed — leave them
            // for the next tick to retry rather than silently dropping transactions.
            const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
            for (const email of llmCandidates) {
              pendingLogs.push({
                ...buildLogBase(email, job),
                outcome: "error",
                bodyLengthRaw: email.body.length,
                bodyLengthSent: email.body.length,
                wasTruncated: email.body.length >= BODY_LIMIT,
                batchSize: llmCandidates.length,
                resolvedBy: "llm",
                geminiConfidence: 0,
                parsedMerchant: errMsg.slice(0, 200),
              });
              llmFailedRowIds.add(email.rowId);
            }
            results = [];
          }

          for (const result of results) {
            const email = llmCandidates[result.emailIndex];
            if (!email) continue;

            const bodyLen = email.body.length;
            const logBase = {
              ...buildLogBase(email, job),
              bodyLengthRaw: bodyLen,
              bodyLengthSent: bodyLen,
              wasTruncated: bodyLen >= BODY_LIMIT,
              batchSize: llmCandidates.length,
            };

            const shadowEmail = email as typeof email & {
              _shadowApplied?: ReturnType<typeof applyTemplate>;
              _shadowKey?: string;
              _shadowTmplId?: string;
              _shadowTmplStatus?: string;
            };

            if (result.outcome !== "parsed" || !result.transactions.length) {
              pendingLogs.push({ ...logBase, outcome: result.outcome, resolvedBy: "llm" });

              // Shadow disagreement: LLM couldn't parse but template had a result
              if (shadowEmail._shadowTmplId && shadowEmail._shadowKey) {
                await recordShadowDisagreement(shadowEmail._shadowTmplId, shadowEmail._shadowKey, shadowEmail._shadowTmplStatus ?? "SHADOW", invocationMap);
              }
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

              pendingLogs.push({
                ...logBase, outcome, geminiConfidence: tx.confidence,
                parsedMerchant: tx.merchant, parsedAmount: tx.amount,
                transactionId: upsertResult.id, resolvedBy: "llm",
              });

              // Template learning: upsert new template from Gemini result if templates provided
              if (result.subjectTemplate && result.bodyTemplate && !shadowEmail._shadowTmplId) {
                const hash = templateHash(email.subject, email.body);
                const geminiApplied = {
                  amount: tx.amount,
                  currency: tx.currency,
                  date: tx.date,
                  transactionType: tx.type as "expense" | "income",
                  ...(tx.merchant ? { merchant: tx.merchant } : {}),
                };
                const extractors = deriveExtractors(
                  email.subject, email.body,
                  result.bodyTemplate, result.subjectTemplate,
                  geminiApplied
                );
                if (Object.keys(extractors).length >= 2) {
                  await upsertTemplate(
                    job.userId, email.senderDomain, hash,
                    result.subjectTemplate, result.bodyTemplate,
                    extractors, invocationMap
                  );
                }
              }

              // Shadow run: compare template result with Gemini result
              if (shadowEmail._shadowApplied && shadowEmail._shadowTmplId && shadowEmail._shadowKey) {
                const geminiForCompare = {
                  amount: tx.amount,
                  currency: tx.currency,
                  date: tx.date,
                  transactionType: tx.type as "expense" | "income",
                  ...(tx.merchant ? { merchant: tx.merchant } : {}),
                };
                const agree = compareOutputs(shadowEmail._shadowApplied, geminiForCompare);
                if (agree) {
                  await recordShadowAgreement(shadowEmail._shadowTmplId, shadowEmail._shadowKey, invocationMap);
                } else {
                  await recordShadowDisagreement(shadowEmail._shadowTmplId, shadowEmail._shadowKey, shadowEmail._shadowTmplStatus ?? "SHADOW", invocationMap);
                }
              }
            }
          }
        }
      }
    }
  }

  // Flush all accumulated ParseLog writes in one batch
  if (pendingLogs.length > 0) {
    await prisma.parseLog.createMany({ data: pendingLogs });
  }

  await prisma.syncJobMessage.updateMany({
    where: {
      id: {
        in: pending
          .map((p) => p.id)
          .filter((id) => !llmFailedRowIds.has(id) && !missingRowIds.has(id)),
      },
    },
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

  // Prune old parse logs and disabled templates (cron only)
  if (isCron) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const pruned = await prisma.parseLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    await prisma.parseTemplate.deleteMany({
      where: { status: "DISABLED", updatedAt: { lt: cutoff } },
    });
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
