// src/lib/vpaLookup.ts
import { prisma } from "@/lib/prisma";

/** Upsert a VPA mapping learned automatically from a bank alert email. */
export async function autoLearnVpa(
  userId: string,
  vpa: string,
  merchantName: string,
  category: string,
  subCategory: string | null,
): Promise<void> {
  if (!vpa || !merchantName || merchantName === "Unknown") return;
  await prisma.vpaMerchantMap.upsert({
    where: { userId_vpa: { userId, vpa: vpa.toLowerCase() } },
    create: {
      userId,
      vpa: vpa.toLowerCase(),
      merchantName,
      category,
      subCategory: subCategory ?? undefined,
      confirmedByUser: false,
    },
    // Only update if not already confirmed by user — confirmed entries take precedence
    update: { merchantName, category, subCategory: subCategory ?? undefined },
  });
}

/** Look up a merchant name for a VPA. Returns null if unknown. */
export async function resolveVpa(
  userId: string,
  vpa: string,
): Promise<{ merchantName: string; category: string; subCategory: string | null } | null> {
  const row = await prisma.vpaMerchantMap.findUnique({
    where: { userId_vpa: { userId, vpa: vpa.toLowerCase() } },
    select: { merchantName: true, category: true, subCategory: true },
  });
  return row ?? null;
}

/** User labels a VPA — updates the mapping and retroactively renames all matching transactions. */
export async function labelVpaByUser(
  userId: string,
  vpa: string,
  merchantName: string,
  category: string,
  subCategory: string | null,
): Promise<{ updatedTransactions: number }> {
  await prisma.vpaMerchantMap.upsert({
    where: { userId_vpa: { userId, vpa: vpa.toLowerCase() } },
    create: {
      userId,
      vpa: vpa.toLowerCase(),
      merchantName,
      category,
      subCategory: subCategory ?? undefined,
      confirmedByUser: true,
    },
    update: {
      merchantName,
      category,
      subCategory: subCategory ?? undefined,
      confirmedByUser: true,
    },
  });

  // Retroactively rename all transactions where the VPA was stored as tag: "vpa:<address>"
  const result = await prisma.transaction.updateMany({
    where: { userId, tag: `vpa:${vpa.toLowerCase()}` },
    data: {
      merchant: merchantName,
      category,
      subCategory: subCategory ?? undefined,
      needsReview: false,
      reviewed: true,
    },
  });

  return { updatedTransactions: result.count };
}

/** Returns all unresolved VPAs — transactions where merchant = "Unknown" and tag = "vpa:xxx". */
export async function getUnresolvedVpas(userId: string): Promise<Array<{
  vpa: string;
  count: number;
  totalAmount: number;
  sampleDate: string;
}>> {
  const rows = await prisma.transaction.groupBy({
    by: ["tag"],
    where: { userId, merchant: "Unknown", tag: { startsWith: "vpa:" } },
    _count: { id: true },
    _sum: { amount: true },
    _min: { date: true },
  });

  return rows.map(r => ({
    vpa: (r.tag ?? "").replace("vpa:", ""),
    count: r._count.id,
    totalAmount: r._sum.amount ?? 0,
    sampleDate: r._min.date?.toISOString().split("T")[0] ?? "",
  }));
}
