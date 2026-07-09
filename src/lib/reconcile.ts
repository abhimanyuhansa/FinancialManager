export type StatementItem = {
  date: string;
  merchant: string;
  amount: number;
  type: "expense" | "income";
};

export type CandidateTransaction = {
  id: string;
  merchant: string;
  amount: number;
  date: Date;
  type: string;
};

export type MatchStatus = "matched" | "mismatch" | "missing";

export function parseStatementItems(raw: string): StatementItem[] {
  if (!raw) return [];
  try {
    const clean = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return [];
    return parsed as StatementItem[];
  } catch {
    return [];
  }
}

type RawItem = {
  date?: string | null;
  merchant?: string | null;
  amount?: number | null;
  type?: string | null;
};

export function normaliseStatementItem(raw: RawItem): StatementItem | null {
  if (!raw.date) return null;
  if (typeof raw.amount !== "number" || raw.amount <= 0) return null;

  const merchant = raw.merchant ?? "Unknown";
  let type: "expense" | "income" = "expense";
  if (raw.type === "income" || raw.type === "credit") type = "income";
  else if (raw.type === "expense" || raw.type === "debit") type = "expense";

  return { date: raw.date, merchant, amount: raw.amount, type };
}

const TWO_DAY_MS = 2 * 24 * 60 * 60 * 1000;

function dateBucket(d: Date): number {
  return Math.floor(d.getTime() / TWO_DAY_MS);
}

export function matchStatementItem(
  item: StatementItem,
  candidates: CandidateTransaction[]
): MatchStatus {
  const itemBucket = dateBucket(new Date(item.date));

  const inWindow = candidates.filter(
    (tx) => dateBucket(tx.date) === itemBucket
  );

  if (inWindow.length === 0) return "missing";

  const exact = inWindow.find(
    (tx) =>
      tx.amount === item.amount &&
      tx.merchant.toLowerCase().replace(/[^a-z0-9]/g, "") ===
        item.merchant.toLowerCase().replace(/[^a-z0-9]/g, "")
  );
  if (exact) return "matched";

  return "mismatch";
}
