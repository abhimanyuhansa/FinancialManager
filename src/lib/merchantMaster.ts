import { prisma } from "@/lib/prisma";

export async function lookupAndUpsertMerchant(
  merchantName: string,
  llmCategory: string,
  llmSubCategory: string | null,
  llmConfidence: number
): Promise<{ category: string; subCategory: string | null }> {
  const key = merchantName.toLowerCase().trim();
  const existing = await prisma.merchantMaster.findUnique({ where: { merchantName: key } });

  if (existing?.source === "user") {
    return { category: existing.category, subCategory: existing.subCategory ?? null };
  }

  if (!existing || (existing.source === "llm" && llmConfidence >= existing.confidence)) {
    await prisma.merchantMaster.upsert({
      where: { merchantName: key },
      create: {
        merchantName: key,
        category: llmCategory,
        subCategory: llmSubCategory,
        confidence: llmConfidence,
        source: "llm",
      },
      update: {
        category: llmCategory,
        subCategory: llmSubCategory,
        confidence: llmConfidence,
      },
    });
  }

  return {
    category: existing?.source === "user" ? existing.category : llmCategory,
    subCategory: existing?.source === "user" ? (existing.subCategory ?? null) : llmSubCategory,
  };
}
