import {
  parseStatementItems,
  normaliseStatementItem,
  matchStatementItem,
  StatementItem,
  CandidateTransaction,
} from "@/lib/reconcile";

describe("parseStatementItems", () => {
  it("parses a valid Gemini JSON array", () => {
    const raw = JSON.stringify([
      { date: "2026-06-15", merchant: "Swiggy", amount: 349, type: "expense" },
      { date: "2026-06-16", merchant: "Salary", amount: 50000, type: "income" },
    ]);
    const items = parseStatementItems(raw);
    expect(items).toHaveLength(2);
    expect(items[0].merchant).toBe("Swiggy");
    expect(items[1].amount).toBe(50000);
  });

  it("strips markdown code fences before parsing", () => {
    const raw = "```json\n[{\"date\":\"2026-06-15\",\"merchant\":\"Zomato\",\"amount\":250,\"type\":\"expense\"}]\n```";
    const items = parseStatementItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].merchant).toBe("Zomato");
  });

  it("returns empty array on invalid JSON", () => {
    const items = parseStatementItems("not json at all");
    expect(items).toHaveLength(0);
  });

  it("returns empty array on empty string", () => {
    expect(parseStatementItems("")).toHaveLength(0);
  });
});

describe("normaliseStatementItem", () => {
  it("maps debit to expense", () => {
    const item = normaliseStatementItem({
      date: "2026-06-15",
      merchant: "Swiggy",
      amount: 349,
      type: "debit",
    });
    expect(item).not.toBeNull();
    expect(item!.type).toBe("expense");
  });

  it("maps credit to income", () => {
    const item = normaliseStatementItem({
      date: "2026-06-15",
      merchant: "HDFC",
      amount: 50000,
      type: "credit",
    });
    expect(item).not.toBeNull();
    expect(item!.type).toBe("income");
  });

  it("returns null when amount <= 0", () => {
    const item = normaliseStatementItem({
      date: "2026-06-15",
      merchant: "Swiggy",
      amount: 0,
      type: "expense",
    });
    expect(item).toBeNull();
  });

  it("returns null when date is missing", () => {
    const item = normaliseStatementItem({
      date: null,
      merchant: "Swiggy",
      amount: 349,
      type: "expense",
    });
    expect(item).toBeNull();
  });
});

describe("matchStatementItem", () => {
  const makeItem = (merchant: string, amount: number, date: string): StatementItem => ({
    date,
    merchant,
    amount,
    type: "expense",
  });

  const makeTx = (merchant: string, amount: number, date: string): CandidateTransaction => ({
    id: "tx1",
    merchant,
    amount,
    date: new Date(date),
    type: "expense",
  });

  it("returns matched when merchant + amount + date bucket align", () => {
    const item = makeItem("Swiggy", 349, "2026-06-15");
    const tx = makeTx("Swiggy", 349, "2026-06-15T10:00:00Z");
    expect(matchStatementItem(item, [tx])).toBe("matched");
  });

  it("returns mismatch when amount differs within date window", () => {
    const item = makeItem("Swiggy", 349, "2026-06-15");
    const tx = makeTx("Swiggy", 300, "2026-06-15T10:00:00Z");
    expect(matchStatementItem(item, [tx])).toBe("mismatch");
  });

  it("returns missing when no transaction in date window", () => {
    const item = makeItem("Swiggy", 349, "2026-06-15");
    const tx = makeTx("Swiggy", 349, "2026-07-01T10:00:00Z");
    expect(matchStatementItem(item, [tx])).toBe("missing");
  });

  it("returns missing when candidate list is empty", () => {
    const item = makeItem("Swiggy", 349, "2026-06-15");
    expect(matchStatementItem(item, [])).toBe("missing");
  });
});
