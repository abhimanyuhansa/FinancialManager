import type { PrismaClient } from "@prisma/client";
import type { ParsedTransaction } from "@/lib/gemini";

export function buildFingerprint(merchant: string, amount: number, date: Date): string {
  const normalizedMerchant = merchant.toLowerCase().replace(/[^a-z0-9]/g, "");
  const dateBucket = Math.floor(date.getTime() / (2 * 24 * 60 * 60 * 1000));
  return `${normalizedMerchant}|${amount}|${dateBucket}`;
}

type UpsertInput = {
  gmailMsgId: string;
  parsed: ParsedTransaction;
  sourceRank: number;
};

export type UpsertResult = "inserted" | "skipped_msgid" | "skipped_fingerprint" | "upgraded";

export async function upsertTransaction(
  prisma: PrismaClient,
  userId: string,
  input: UpsertInput
): Promise<UpsertResult> {
  const { gmailMsgId, parsed, sourceRank } = input;

  // Layer 2: skip if gmailMsgId already processed
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

  // Layer 3 + 4: check fingerprint collision
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
