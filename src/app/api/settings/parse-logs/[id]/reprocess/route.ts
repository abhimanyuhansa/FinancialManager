import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { parseEmailBatch } from "@/lib/gemini";
import { upsertTransactionV2 } from "@/lib/dedup";
import { lookupAndUpsertMerchant } from "@/lib/merchantMaster";

type RouteContext = { params: Promise<{ id: string }> };

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

export async function POST(_req: Request, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const { id } = await params;

  const log = await prisma.parseLog.findUnique({
    where: { id },
    select: { id: true, userId: true, gmailMsgId: true, syncJobId: true, senderDomain: true },
  });

  if (!log || log.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please reconnect Gmail" }, { status: 400 });
  }

  const msg = await fetchFullMessage(accessToken, log.gmailMsgId);
  if (!msg) {
    return NextResponse.json({ error: "Could not fetch Gmail message" }, { status: 400 });
  }

  const results = await parseEmailBatch(
    [{ emailIndex: 0, body: msg.body, senderName: msg.senderName, fallbackDate: msg.receivedDate }],
    apiKey
  );

  const result = results[0];
  if (!result) {
    return NextResponse.json({ error: "No result from Gemini" }, { status: 500 });
  }

  if (result.outcome !== "parsed" || !result.transactions.length) {
    await prisma.parseLog.update({
      where: { id: log.id },
      data: {
        outcome: result.outcome,
        bodyLengthRaw: result.bodyLengthRaw,
        bodyLengthSent: result.bodyLengthSent,
        wasTruncated: result.wasTruncated,
      },
    });
    return NextResponse.json({ outcome: result.outcome });
  }

  const tx = result.transactions[0];
  const { category, subCategory } = await lookupAndUpsertMerchant(
    tx.merchant, tx.category, tx.subCategory ?? null, tx.confidence ?? 0
  );

  const upsertResult = await upsertTransactionV2(prisma, {
    userId,
    gmailMsgId: log.gmailMsgId,
    date: new Date(tx.date),
    merchant: tx.merchant,
    amount: tx.amount,
    type: tx.type,
    currency: tx.currency,
    category,
    source: "gmail",
    sourceRank: 1,
    confidence: tx.confidence,
    needsReview: tx.needsReview,
    subCategory: subCategory ?? undefined,
    lineItems: tx.lineItems ?? undefined,
  });

  const finalOutcome = upsertResult.action === "inserted" ? "inserted"
    : upsertResult.action === "upgraded" ? "upgraded"
    : "skipped_duplicate";

  await prisma.parseLog.update({
    where: { id: log.id },
    data: {
      outcome: finalOutcome,
      geminiConfidence: tx.confidence,
      parsedMerchant: tx.merchant,
      parsedAmount: tx.amount,
      transactionId: upsertResult.id ?? undefined,
      bodyLengthRaw: result.bodyLengthRaw,
      bodyLengthSent: result.bodyLengthSent,
      wasTruncated: result.wasTruncated,
    },
  });

  return NextResponse.json({ outcome: finalOutcome, transactionId: upsertResult.id });
}
