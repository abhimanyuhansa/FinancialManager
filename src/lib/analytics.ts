export type BadgeVariant = "good" | "bad" | "neutral";
export type BadgeMetric = "networth" | "income" | "expense" | "savings" | "yoy_spend";
export type Direction = "up" | "down" | "unchanged";

export function getBadgeVariant(metric: BadgeMetric, direction: Direction): BadgeVariant {
  if (direction === "unchanged") return "neutral";
  const goodWhenUp: BadgeMetric[] = ["networth", "income", "savings"];
  const goodWhenDown: BadgeMetric[] = ["expense", "yoy_spend"];
  if (goodWhenUp.includes(metric)) return direction === "up" ? "good" : "bad";
  if (goodWhenDown.includes(metric)) return direction === "down" ? "good" : "bad";
  return "neutral";
}

type TxForKpi = { amount: number; type: "income" | "expense" };

export type KpiResult = { income: number; expenses: number; netWorth: number };

export function computeKpis(transactions: TxForKpi[], assetTotal: number): KpiResult {
  let income = 0;
  let expenses = 0;
  for (const tx of transactions) {
    if (tx.type === "income") income += tx.amount;
    else expenses += tx.amount;
  }
  return { income, expenses, netWorth: assetTotal + income - expenses };
}

type TxForMonthly = { amount: number; type: "income" | "expense"; date: Date };

export type MonthlyTotal = { month: string; income: number; expenses: number };

export function computeMonthlyTotals(transactions: TxForMonthly[]): MonthlyTotal[] {
  const map = new Map<string, MonthlyTotal>();
  for (const tx of transactions) {
    const month = tx.date.toISOString().slice(0, 7);
    if (!map.has(month)) map.set(month, { month, income: 0, expenses: 0 });
    const entry = map.get(month)!;
    if (tx.type === "income") entry.income += tx.amount;
    else entry.expenses += tx.amount;
  }
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
}

type TxForCategory = { amount: number; type: "income" | "expense"; category: string };

export type CategoryTotal = { category: string; amount: number };

export function computeCategoryBreakdown(transactions: TxForCategory[]): CategoryTotal[] {
  const map = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.type !== "expense") continue;
    map.set(tx.category, (map.get(tx.category) ?? 0) + tx.amount);
  }
  return Array.from(map.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}
