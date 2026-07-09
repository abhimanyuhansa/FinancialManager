import { prisma } from "@/lib/prisma";
import { matchesEmailFilter } from "@/lib/emailFilter";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (buffer: Buffer, options?: Record<string, unknown>) => Promise<{ text: string }>;

export type PdfResult =
  | { status: "ok"; text: string }
  | { status: "encrypted" }
  | { status: "failed"; error: string };

export async function fetchPdfAttachment(
  accessToken: string,
  msgId: string,
  attachmentId: string
): Promise<PdfResult> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return { status: "failed", error: `HTTP ${res.status}` };

  const data = await res.json() as { data?: string };
  if (!data.data) return { status: "failed", error: "Empty attachment" };

  const buffer = Buffer.from(data.data, "base64url");

  try {
    const result = await pdfParse(buffer);
    return { status: "ok", text: result.text.slice(0, 3000) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("password") || msg.toLowerCase().includes("encrypted")) {
      return { status: "encrypted" };
    }
    return { status: "failed", error: msg };
  }
}

export async function getGmailToken(userId: string): Promise<string | null> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
    select: { access_token: true, refresh_token: true, expires_at: true },
  });
  if (!account) {
    console.warn(`[gmail] No Google account found for user ${userId}`);
    return null;
  }

  // Check if token is still valid (with 60s buffer)
  const nowSec = Math.floor(Date.now() / 1000);
  const isExpired = account.expires_at != null && account.expires_at < nowSec + 60;

  if (!isExpired && account.access_token) {
    return account.access_token;
  }

  // Token expired or missing — try to refresh
  if (!account.refresh_token) {
    console.warn(`[gmail] Access token expired and no refresh_token for user ${userId}`);
    return null;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: account.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[gmail] Token refresh failed: ${res.status}`, err);
      return null;
    }
    const tokens = (await res.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };
    const newExpiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
    await prisma.account.updateMany({
      where: { userId, provider: "google" },
      data: { access_token: tokens.access_token, expires_at: newExpiresAt },
    });
    console.log(`[gmail] Token refreshed for user ${userId}, expires_at=${newExpiresAt}`);
    return tokens.access_token;
  } catch (e) {
    console.error(`[gmail] Token refresh error:`, e);
    return null;
  }
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
    console.error(`[gmail] fetchMessageMetadataList failed: ${listRes.status}`, err);
    throw new Error(`Gmail list failed: ${listRes.status} ${err}`);
  }

  const listData = await listRes.json() as { messages?: GmailMessageRef[]; nextPageToken?: string };
  const refs = listData.messages ?? [];
  console.log(`[gmail] fetchMessageMetadataList: ${refs.length} message refs returned (pageToken=${pageToken ?? "none"})`);

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
