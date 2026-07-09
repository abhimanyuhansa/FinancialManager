import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import {
  parseStatementItems,
  normaliseStatementItem,
  matchStatementItem,
  CandidateTransaction,
} from "@/lib/reconcile";

const STATEMENT_SYSTEM_PROMPT =
  "This is a bank or credit card statement. Extract every transaction listed. " +
  "Return a JSON array where each item has: " +
  '{"date": string, "merchant": string, "amount": number, "type": "expense"|"debit"|"credit"|"income"}. ' +
  "Return only the array. No explanations.";

async function fetchStatementBody(
  accessToken: string,
  msgId: string
): Promise<{ body: string; receivedDate: string } | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;

  const msg = await res.json() as {
    internalDate?: string;
    payload?: {
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    };
  };

  const receivedDate = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  const parts = msg.payload?.parts ?? [];
  const plainPart = parts.find((p) => p.mimeType === "text/plain");
  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  const rawData =
    plainPart?.body?.data ?? htmlPart?.body?.data ?? msg.payload?.body?.data ?? "";

  if (!rawData) return { body: "", receivedDate };

  const decoded = Buffer.from(rawData, "base64url").toString("utf-8");
  const body = decoded
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);

  return { body, receivedDate };
}

async function callGeminiForStatement(body: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: STATEMENT_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `Statement:\n${body}` }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) return "[]";
  const data = await res.json() as {
    candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
}

const TWO_DAY_MS = 2 * 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { gmailMsgId } = (await req.json()) as { gmailMsgId?: string };
  if (!gmailMsgId) {
    return NextResponse.json({ error: "Missing gmailMsgId" }, { status: 400 });
  }

  const accessToken = await getGmailToken(userId);
  if (!accessToken) {
    return NextResponse.json({ error: "No Gmail token — please sign in again" }, { status: 401 });
  }

  const statement = await fetchStatementBody(accessToken, gmailMsgId);
  if (!statement || !statement.body) {
    return NextResponse.json({ error: "Could not fetch statement email" }, { status: 422 });
  }

  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const geminiRaw = await callGeminiForStatement(statement.body, apiKey);

  const rawItems = parseStatementItems(geminiRaw);
  const items = rawItems
    .map((raw) => normaliseStatementItem(raw))
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) {
    return NextResponse.json({ error: "No line items extracted from statement" }, { status: 422 });
  }

  const dates = items.map((item) => new Date(item.date).getTime()).filter((d) => !isNaN(d));
  const minDate = new Date(Math.min(...dates) - 30 * 24 * 60 * 60 * 1000);
  const maxDate = new Date(Math.max(...dates) + 30 * 24 * 60 * 60 * 1000);

  const dbTransactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: minDate, lte: maxDate } },
    select: { id: true, merchant: true, amount: true, date: true, type: true },
  });

  const candidates: CandidateTransaction[] = dbTransactions.map((tx) => ({
    id: tx.id,
    merchant: tx.merchant,
    amount: tx.amount,
    date: tx.date,
    type: tx.type,
  }));

  let matched = 0;
  let missing = 0;
  let mismatch = 0;

  for (const item of items) {
    const status = matchStatementItem(item, candidates);
    if (status === "matched") matched++;
    else if (status === "missing") missing++;
    else mismatch++;

    const itemBucket = Math.floor(new Date(item.date).getTime() / TWO_DAY_MS);

    const matchedTx =
      status === "matched"
        ? candidates.find((tx) => {
            const txBucket = Math.floor(tx.date.getTime() / TWO_DAY_MS);
            return (
              txBucket === itemBucket &&
              tx.amount === item.amount &&
              tx.merchant.toLowerCase().replace(/[^a-z0-9]/g, "") ===
                item.merchant.toLowerCase().replace(/[^a-z0-9]/g, "")
            );
          })
        : null;

    const mismatchDetails =
      status === "mismatch"
        ? (() => {
            const inWindow = candidates.filter(
              (tx) => Math.floor(tx.date.getTime() / TWO_DAY_MS) === itemBucket
            );
            const first = inWindow[0];
            if (!first) return null;
            const parts: string[] = [];
            if (first.amount !== item.amount)
              parts.push(`amount differs: statement=${item.amount}, captured=${first.amount}`);
            if (
              first.merchant.toLowerCase().replace(/[^a-z0-9]/g, "") !==
              item.merchant.toLowerCase().replace(/[^a-z0-9]/g, "")
            )
              parts.push(
                `merchant differs: statement="${item.merchant}", captured="${first.merchant}"`
              );
            return parts.join("; ") || null;
          })()
        : null;

    await prisma.reconciliationLog.create({
      data: {
        userId,
        statementGmailMsgId: gmailMsgId,
        statementDate: new Date(item.date),
        statementMerchant: item.merchant,
        statementAmount: item.amount,
        matchedTransactionId: matchedTx?.id ?? null,
        status,
        mismatchDetails,
      },
    });
  }

  return NextResponse.json({ totalItems: items.length, matched, missing, mismatch });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const logs = await prisma.reconciliationLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      statementGmailMsgId: true,
      statementDate: true,
      statementMerchant: true,
      statementAmount: true,
      matchedTransactionId: true,
      status: true,
      mismatchDetails: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ logs });
}
