import { prisma } from "@/lib/prisma";
import {
  SUPPORTED_FILTER_EVALUATOR_VERSION,
  SUPPORTED_RULE_SCHEMA_VERSION,
  validateFilterRules,
} from "@/lib/scan/filterEvaluator";

export const DEFAULT_INVENTORY_QUERY =
  "in:inbox -category:promotions -category:social -category:forums";

export async function connectedGmailAccountId(userId: string) {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google", disconnectedAt: null },
    select: { id: true },
  });
  return account?.id ?? null;
}

export function parseFilterVersionInput(value: unknown) {
  const body =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const gmailQuery =
    typeof body.gmailQuery === "string" ? body.gmailQuery.trim() : "";
  if (!gmailQuery || gmailQuery.length > 1_500) {
    throw new Error("Invalid Gmail query");
  }
  const rules = validateFilterRules(
    body.includeRules ?? [],
    body.excludeRules ?? [],
  );
  return { gmailQuery, ...rules };
}

export async function createFilterWithVersion(input: {
  userId: string;
  gmailAccountId: string;
  name: string;
  gmailQuery: string;
  includeRules: ReturnType<typeof validateFilterRules>["includeRules"];
  excludeRules: ReturnType<typeof validateFilterRules>["excludeRules"];
}) {
  return prisma.$transaction(async (tx) => {
    const filter = await tx.userEmailFilter.create({
      data: {
        userId: input.userId,
        gmailAccountId: input.gmailAccountId,
        name: input.name,
      },
    });
    const version = await tx.emailFilterVersion.create({
      data: {
        emailFilterId: filter.id,
        version: 1,
        gmailQuery: input.gmailQuery,
        includeRulesJson: input.includeRules,
        excludeRulesJson: input.excludeRules,
        ruleSchemaVersion: SUPPORTED_RULE_SCHEMA_VERSION,
        filterEvaluatorVersion: SUPPORTED_FILTER_EVALUATOR_VERSION,
        createdBy: input.userId,
      },
    });
    return tx.userEmailFilter.update({
      where: { id: filter.id },
      data: { currentVersionId: version.id, updatedAt: new Date() },
      include: { currentVersion: true },
    });
  });
}

export async function createNextFilterVersion(input: {
  userId: string;
  filterId: string;
  gmailQuery: string;
  includeRules: ReturnType<typeof validateFilterRules>["includeRules"];
  excludeRules: ReturnType<typeof validateFilterRules>["excludeRules"];
}) {
  return prisma.$transaction(async (tx) => {
    const owned = await tx.userEmailFilter.findFirst({
      where: { id: input.filterId, userId: input.userId },
      include: { currentVersion: true },
    });
    if (!owned) return null;

    const nextVersion = (owned.currentVersion?.version ?? 0) + 1;
    const version = await tx.emailFilterVersion.create({
      data: {
        emailFilterId: owned.id,
        version: nextVersion,
        gmailQuery: input.gmailQuery,
        includeRulesJson: input.includeRules,
        excludeRulesJson: input.excludeRules,
        ruleSchemaVersion: SUPPORTED_RULE_SCHEMA_VERSION,
        filterEvaluatorVersion: SUPPORTED_FILTER_EVALUATOR_VERSION,
        supersedesVersionId: owned.currentVersionId,
        createdBy: input.userId,
      },
    });
    const changed = await tx.userEmailFilter.updateMany({
      where: {
        id: owned.id,
        userId: input.userId,
        currentVersionId: owned.currentVersionId,
      },
      data: { currentVersionId: version.id, updatedAt: new Date() },
    });
    if (changed.count !== 1) throw new Error("filter_version_conflict");
    return version;
  });
}
