import { prisma } from "@/lib/prisma";

export async function buildGmailQueryFromDB(fromDate: Date): Promise<string> {
  const keywords = await prisma.gmailQueryKeyword.findMany({ where: { isActive: true } });
  const fromKws = keywords.filter((k) => k.type === "from").map((k) => k.value);
  const subjKws = keywords.filter((k) => k.type === "subject").map((k) => k.value);

  const afterSeconds = Math.floor(fromDate.getTime() / 1000);

  const fromPart = fromKws.length > 0 ? `from:(${fromKws.join(" OR ")})` : "";
  const subjPart = subjKws.length > 0 ? `subject:(${subjKws.join(" OR ")})` : "";
  const keywordPart = [fromPart, subjPart].filter(Boolean).join(" OR ");

  return [
    `after:${afterSeconds}`,
    `-category:promotions`,
    `-category:social`,
    `-category:forums`,
    `(${keywordPart})`,
  ]
    .filter(Boolean)
    .join(" ");
}

// Keep old function as fallback for any remaining callers during migration
export function buildGmailQuery(fromDate: Date): string {
  const afterSeconds = Math.floor(fromDate.getTime() / 1000);
  return `after:${afterSeconds} in:inbox -category:promotions -category:social -category:forums`;
}
