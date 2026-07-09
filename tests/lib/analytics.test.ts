import {
  getBadgeVariant,
  computeKpis,
  computeMonthlyTotals,
  computeCategoryBreakdown,
} from "@/lib/analytics";

describe("getBadgeVariant", () => {
  it("networth up → good", () => expect(getBadgeVariant("networth", "up")).toBe("good"));
  it("networth down → bad", () => expect(getBadgeVariant("networth", "down")).toBe("bad"));
  it("income up → good", () => expect(getBadgeVariant("income", "up")).toBe("good"));
  it("income down → bad", () => expect(getBadgeVariant("income", "down")).toBe("bad"));
  it("expense up → bad", () => expect(getBadgeVariant("expense", "up")).toBe("bad"));
  it("expense down → good", () => expect(getBadgeVariant("expense", "down")).toBe("good"));
  it("unchanged → neutral", () => expect(getBadgeVariant("income", "unchanged")).toBe("neutral"));
});

describe("computeKpis", () => {
  const transactions = [
    { amount: 50000, type: "income" as const, category: "income", date: new Date("2026-06-15") },
    { amount: 349, type: "expense" as const, category: "food", date: new Date("2026-06-16") },
    { amount: 1200, type: "expense" as const, category: "transport", date: new Date("2026-06-17") },
  ];

  it("sums income correctly", () => {
    const kpis = computeKpis(transactions, 100000);
    expect(kpis.income).toBe(50000);
  });

  it("sums expenses correctly", () => {
    const kpis = computeKpis(transactions, 100000);
    expect(kpis.expenses).toBe(1549);
  });

  it("netWorth = assetTotal + income - expenses", () => {
    const kpis = computeKpis(transactions, 100000);
    expect(kpis.netWorth).toBe(100000 + 50000 - 1549);
  });
});

describe("computeMonthlyTotals", () => {
  const transactions = [
    { amount: 300, type: "expense" as const, date: new Date("2026-05-10") },
    { amount: 500, type: "expense" as const, date: new Date("2026-05-20") },
    { amount: 1000, type: "income" as const, date: new Date("2026-05-15") },
    { amount: 400, type: "expense" as const, date: new Date("2026-06-05") },
    { amount: 2000, type: "income" as const, date: new Date("2026-06-10") },
  ];

  it("groups by month key", () => {
    const totals = computeMonthlyTotals(transactions);
    expect(totals).toHaveLength(2);
    expect(totals[0].month).toBe("2026-05");
    expect(totals[1].month).toBe("2026-06");
  });

  it("sums income and expenses per month", () => {
    const totals = computeMonthlyTotals(transactions);
    expect(totals[0].income).toBe(1000);
    expect(totals[0].expenses).toBe(800);
    expect(totals[1].income).toBe(2000);
    expect(totals[1].expenses).toBe(400);
  });
});

describe("computeCategoryBreakdown", () => {
  const transactions = [
    { amount: 349, type: "expense" as const, category: "food" },
    { amount: 200, type: "expense" as const, category: "food" },
    { amount: 500, type: "expense" as const, category: "transport" },
    { amount: 50000, type: "income" as const, category: "income" },
  ];

  it("sums amounts by category (expenses only)", () => {
    const breakdown = computeCategoryBreakdown(transactions);
    const food = breakdown.find((c) => c.category === "food");
    expect(food?.amount).toBe(549);
  });

  it("excludes income transactions", () => {
    const breakdown = computeCategoryBreakdown(transactions);
    const income = breakdown.find((c) => c.category === "income");
    expect(income).toBeUndefined();
  });

  it("sorts by amount descending", () => {
    const breakdown = computeCategoryBreakdown(transactions);
    expect(breakdown[0].category).toBe("food");    // food=549 > transport=500
    expect(breakdown[1].category).toBe("transport");
  });
});
