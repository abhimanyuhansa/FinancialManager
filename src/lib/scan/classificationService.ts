import { prisma } from "@/lib/prisma";

export const EMAIL_CLASSIFICATIONS = [
  "UNREVIEWED",
  "FINANCIAL",
  "NON_FINANCIAL",
  "UNCERTAIN",
] as const;

export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number];

export async function classifyEmail(input: {
  userId: string;
  sourceId: string;
  classification: EmailClassification;
  reason?: string;
}) {
  const source = await prisma.emailSource.findFirst({
    where: { id: input.sourceId, userId: input.userId, deletedAt: null },
    select: {
      id: true,
      currentManualClassification: true,
      classificationVersion: true,
    },
  });
  if (!source) return { outcome: "not_found" as const };
  if (source.currentManualClassification === input.classification) {
    return {
      outcome: "unchanged" as const,
      classification: source.currentManualClassification,
      version: source.classificationVersion,
    };
  }

  const newVersion = source.classificationVersion + 1;
  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.emailSource.updateMany({
        where: {
          id: source.id,
          userId: input.userId,
          classificationVersion: source.classificationVersion,
        },
        data: {
          currentManualClassification: input.classification,
          classificationVersion: newVersion,
        },
      });
      if (updated.count !== 1) throw new Error("classification_conflict");
      await tx.emailManualClassification.create({
        data: {
          userId: input.userId,
          emailSourceId: source.id,
          previousClassification: source.currentManualClassification,
          newClassification: input.classification,
          reason: input.reason ?? null,
          classifiedBy: input.userId,
          classificationVersion: newVersion,
        },
      });
    });
  } catch {
    return { outcome: "conflict" as const };
  }
  return {
    outcome: "changed" as const,
    classification: input.classification,
    version: newVersion,
  };
}
