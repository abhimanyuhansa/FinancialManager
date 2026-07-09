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

type GmailMessageRef = {
  id: string;
  threadId: string;
};

export async function fetchMessageMetadataList(
  accessToken: string,
  afterDate: Date,
  pageToken?: string
): Promise<{ messages: EmailMeta[]; nextPageToken?: string }> {
  const afterSeconds = Math.floor(afterDate.getTime() / 1000);
  const params = new URLSearchParams({
    maxResults: "500",
    q: `after:${afterSeconds}`,
  });
  if (pageToken) params.set("pageToken", pageToken);

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`Gmail list failed: ${listRes.status} ${err}`);
  }

  const listData = await listRes.json() as { messages?: GmailMessageRef[]; nextPageToken?: string };
  const refs = listData.messages ?? [];

  const BATCH = 20;
  const results: EmailMeta[] = [];

  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = refs.slice(i, i + BATCH);
    const metaBatch = await Promise.all(
      batch.map(async (ref) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!msgRes.ok) return null;
        const msg = await msgRes.json() as {
          id: string;
          payload?: { headers?: Array<{ name: string; value: string }> };
          internalDate?: string;
        };
        const headers = msg.payload?.headers ?? [];
        const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
        return {
          id: msg.id,
          from: get("From").replace(/.*<(.+)>/, "$1").trim(),
          subject: get("Subject"),
          date: get("Date") || (msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : ""),
        } satisfies EmailMeta;
      })
    );
    results.push(...metaBatch.filter((m): m is EmailMeta => m !== null));
  }

  return { messages: results, nextPageToken: listData.nextPageToken };
}
