import type { PrismaClient } from "@prisma/client";
import type { ParsedTransaction } from "@/lib/gemini";

export function buildFingerprint(merchant: string, amount: number, date: Date): string {
  const normalizedMerchant = merchant.toLowerCase().replace(/[^a-z0-9]/g, "");
  const dateBucket = Math.floor(date.getTime() / (2 * 24 * 60 * 60 * 1000));
  return `${normalizedMerchant}|${amount}|${dateBucket}`;
}

type UpsertLegacyInput = {
  gmailMsgId: string;
  parsed: ParsedTransaction;
  sourceRank: number;
};

export type UpsertResult = "inserted" | "skipped_msgid" | "skipped_fingerprint" | "upgraded";

export async function upsertTransaction(
  prisma: PrismaClient,
  userId: string,
  input: UpsertLegacyInput
): Promise<UpsertResult> {
  const { gmailMsgId, parsed, sourceRank } = input;

  const existing = await prisma.transaction.findUnique({
    where: { userId_gmailMsgId: { userId, gmailMsgId } },
    select: { id: true },
  });
  if (existing) {
    console.log(`[dedup] skipped_msgid: gmailMsgId=${gmailMsgId}`);
    return "skipped_msgid";
  }

  const date = new Date(parsed.date);
  const fingerprint = buildFingerprint(parsed.merchant, parsed.amount, date);

  const fpExisting = await prisma.transaction.findUnique({
    where: { userId_fingerprint: { userId, fingerprint } },
    select: { id: true, sourceRank: true },
  });

  if (fpExisting) {
    if (sourceRank < fpExisting.sourceRank) {
      await prisma.transaction.update({
        where: { id: fpExisting.id },
        data: {
          gmailMsgId,
          sourceRank,
          merchant: parsed.merchant,
          amount: parsed.amount,
          type: parsed.type,
          category: parsed.category,
          currency: parsed.currency,
          needsReview: parsed.needsReview,
        },
      });
      console.log(`[dedup] upgraded: fingerprint=${fingerprint} newRank=${sourceRank}`);
      return "upgraded";
    }
    console.log(`[dedup] skipped_fingerprint: fingerprint=${fingerprint}`);
    return "skipped_fingerprint";
  }

  await prisma.transaction.create({
    data: {
      userId,
      gmailMsgId,
      fingerprint,
      date,
      merchant: parsed.merchant,
      amount: parsed.amount,
      type: parsed.type,
      currency: parsed.currency,
      category: parsed.category,
      sourceRank,
      needsReview: parsed.needsReview,
    },
  });
  console.log(`[dedup] inserted: merchant="${parsed.merchant}" amount=${parsed.amount} date=${parsed.date}`);
  return "inserted";
}

// New-style upsert used by chunk/v2, reprocess, and advance routes
export type UpsertTransactionInput = {
  userId: string;
  gmailMsgId: string;
  date: Date;
  merchant: string;
  amount: number;
  type: string;
  currency: string;
  category: string;
  source: string;
  sourceRank: number;
  confidence?: number;
  needsReview?: boolean;
};

export type UpsertTransactionResult = { action: "inserted" | "upgraded" | "skipped"; id?: string };

export async function upsertTransactionV2(
  prismaClient: PrismaClient,
  input: UpsertTransactionInput
): Promise<UpsertTransactionResult> {
  const { userId, gmailMsgId, date, merchant, amount, type, currency, category, source, sourceRank, needsReview } = input;

  const existing = await prismaClient.transaction.findUnique({
    where: { userId_gmailMsgId: { userId, gmailMsgId } },
    select: { id: true },
  });
  if (existing) {
    console.log(`[dedup] skipped_msgid: gmailMsgId=${gmailMsgId}`);
    return { action: "skipped", id: existing.id };
  }

  const fingerprint = buildFingerprint(merchant, amount, date);
  const fpExisting = await prismaClient.transaction.findUnique({
    where: { userId_fingerprint: { userId, fingerprint } },
    select: { id: true, sourceRank: true },
  });

  if (fpExisting) {
    if (sourceRank < fpExisting.sourceRank) {
      await prismaClient.transaction.update({
        where: { id: fpExisting.id },
        data: { gmailMsgId, sourceRank, merchant, amount, type, category, currency, needsReview },
      });
      console.log(`[dedup] upgraded: fingerprint=${fingerprint}`);
      return { action: "upgraded", id: fpExisting.id };
    }
    console.log(`[dedup] skipped_fingerprint: fingerprint=${fingerprint}`);
    return { action: "skipped", id: fpExisting.id };
  }

  const tx = await prismaClient.transaction.create({
    data: {
      userId,
      gmailMsgId,
      fingerprint,
      date,
      merchant,
      amount,
      type,
      currency,
      category,
      source,
      sourceRank,
      needsReview: needsReview ?? false,
    },
  });
  console.log(`[dedup] inserted: merchant="${merchant}" amount=${amount}`);
  return { action: "inserted", id: tx.id };
}
