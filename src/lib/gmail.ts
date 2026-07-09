import { prisma } from "@/lib/prisma";
import { matchesEmailFilter } from "@/lib/emailFilter";

export async function getGmailToken(userId: string): Promise<string | null> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
    select: { access_token: true },
  });
  return account?.access_token ?? null;
}

export type EmailMeta = {
  id: string;
  from: string;
  subject: string;
  date: string;
};

export type SenderSummary = {
  sender: string;
  domain: string;
  emailCount: number;
  sampleSubjects: string[];
  sourceRank: number;
  existsInFilter: boolean;
};

export type ScanResult = {
  totalScanned: number;
  financialFound: number;
  autoApproved: SenderSummary[];
  needsReview: SenderSummary[];
};

type FilterLike = {
  type: string;
  value: string;
  sourceRank: number;
  isActive: boolean;
};

export function classifySenders(emails: EmailMeta[], filters: FilterLike[]): ScanResult {
  const domainFilters = filters.filter((f) => f.type !== "subject_keyword");
  const keywordFilters = filters.filter((f) => f.type === "subject_keyword");

  const senderMap = new Map<string, { emails: EmailMeta[]; sourceRank: number; confidence: "high" | "low" }>();

  for (const email of emails) {
    const domainMatch = matchesEmailFilter(email, domainFilters);
    const keywordMatch = matchesEmailFilter(email, keywordFilters);

    if (!domainMatch.matched && !keywordMatch.matched) continue;

    const rank = domainMatch.matched ? domainMatch.sourceRank : keywordMatch.matched ? keywordMatch.sourceRank : 3;
    const confidence: "high" | "low" = domainMatch.matched ? "high" : "low";

    const existing = senderMap.get(email.from);
    if (existing) {
      existing.emails.push(email);
      if (confidence === "high") existing.confidence = "high";
      if (rank < existing.sourceRank) existing.sourceRank = rank;
    } else {
      senderMap.set(email.from, { emails: [email], sourceRank: rank, confidence });
    }
  }

  const autoApproved: SenderSummary[] = [];
  const needsReview: SenderSummary[] = [];

  for (const [sender, data] of senderMap.entries()) {
    const domain = sender.split("@")[1] ?? sender;
    const summary: SenderSummary = {
      sender,
      domain,
      emailCount: data.emails.length,
      sampleSubjects: data.emails.slice(0, 3).map((e) => e.subject),
      sourceRank: data.sourceRank,
      existsInFilter: false,
    };
    if (data.confidence === "high") {
      autoApproved.push(summary);
    } else {
      needsReview.push(summary);
    }
  }

  return {
    totalScanned: emails.length,
    financialFound: autoApproved.length + needsReview.length,
    autoApproved,
    needsReview,
  };
}

export type LookbackPeriod = "1m" | "3m" | "6m";

export function buildScanFromDate(period: LookbackPeriod, now: Date = new Date()): Date {
  const d = new Date(now);
  const months = period === "1m" ? 1 : period === "3m" ? 3 : 6;
  d.setMonth(d.getMonth() - months);
  return d;
}
