import { canonicalise, templateHash } from "@/lib/parseTemplateCache";
import { applyTemplate, compareOutputs, type ExtractorMap, type RegexExtractor } from "@/lib/parseTemplateCache";

describe("canonicalise", () => {
  it("lowercases text", () => {
    expect(canonicalise("Hello World")).toBe("hello world");
  });

  it("normalises CRLF to LF", () => {
    expect(canonicalise("line1\r\nline2")).toBe("line1\nline2");
  });

  it("collapses horizontal whitespace", () => {
    expect(canonicalise("a   b\t\tc")).toBe("a b c");
  });

  it("collapses 3+ blank lines to 2", () => {
    expect(canonicalise("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(canonicalise("  hello  ")).toBe("hello");
  });

  it("is deterministic — same input always same output", () => {
    const text = "  Rs. 1,234.56 debited from your account\r\n\r\n\r\n  on 12-07-26  ";
    expect(canonicalise(text)).toBe(canonicalise(text));
  });
});

describe("templateHash", () => {
  it("returns a 64-char hex string", () => {
    const h = templateHash("subject", "body");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same subject+body always produces same hash", () => {
    expect(templateHash("sub", "bod")).toBe(templateHash("sub", "bod"));
  });

  it("different subject → different hash", () => {
    expect(templateHash("sub1", "bod")).not.toBe(templateHash("sub2", "bod"));
  });

  it("different body → different hash", () => {
    expect(templateHash("sub", "bod1")).not.toBe(templateHash("sub", "bod2"));
  });

  it("whitespace normalization: extra spaces produce same hash", () => {
    expect(templateHash("sub", "hello   world")).toBe(templateHash("sub", "hello world"));
  });
});

const SAMPLE_EXTRACTORS: ExtractorMap = {
  amount:          { regex: "Rs\\.\\s*([\\d,]+(?:\\.\\d{1,2})?)", group: 1, transform: "parseAmount" },
  currency:        { static: "INR" },
  date:            { regex: "on\\s+(\\d{2}-\\d{2}-\\d{2})", group: 1, transform: "normaliseDate" },
  transactionType: { regex: "(debited|credited)", group: 1, transform: "debitCreditToType" },
  merchant:        { regex: "at\\s+([A-Za-z][A-Za-z\\s]+?)(?:\\s|$)", group: 1, transform: "trimMerchant" },
};

describe("applyTemplate", () => {
  it("extracts required fields from a matching body", () => {
    const body = "Rs. 1,234.56 debited from your a/c on 12-07-26 at Swiggy via UPI";
    const result = applyTemplate(body, SAMPLE_EXTRACTORS);
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(1234.56);
    expect(result!.currency).toBe("INR");
    expect(result!.transactionType).toBe("expense");
    expect(result!.merchant).toBe("swiggy");
    expect(result!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null when a required field regex does not match", () => {
    const body = "Hello, your package has been shipped";
    const result = applyTemplate(body, SAMPLE_EXTRACTORS);
    expect(result).toBeNull();
  });

  it("parseAmount strips commas and returns a number", () => {
    const body = "Rs. 1,00,000.00 debited on 01-01-26 at Shop";
    const result = applyTemplate(body, {
      amount: { regex: "Rs\\.\\s*([\\d,]+(?:\\.\\d{1,2})?)", group: 1, transform: "parseAmount" },
      currency: { static: "INR" },
      date: { regex: "(\\d{2}-\\d{2}-\\d{2})", group: 1, transform: "normaliseDate" },
      transactionType: { static: "expense" } as unknown as RegexExtractor,
    });
    expect(result?.amount).toBe(100000);
  });
});

describe("compareOutputs", () => {
  const base = {
    amount: 500,
    currency: "INR",
    date: "2026-07-12",
    transactionType: "expense" as const,
    merchant: "swiggy",
  };

  it("returns true when all required fields match", () => {
    expect(compareOutputs(base, base)).toBe(true);
  });

  it("amount comparison uses integer cents to avoid float equality issues", () => {
    const a = { ...base, amount: 100.1 };
    const b = { ...base, amount: 100.10000000001 };
    expect(compareOutputs(a, b)).toBe(true);
  });

  it("returns false on amount mismatch", () => {
    expect(compareOutputs(base, { ...base, amount: 501 })).toBe(false);
  });

  it("returns false on transactionType mismatch", () => {
    expect(compareOutputs(base, { ...base, transactionType: "income" })).toBe(false);
  });

  it("merchant comparison is case-insensitive and whitespace-collapsed", () => {
    expect(compareOutputs({ ...base, merchant: "  Swiggy  " }, { ...base, merchant: "swiggy" })).toBe(true);
  });

  it("vpa presence mismatch counts as disagreement", () => {
    expect(compareOutputs({ ...base, vpa: "merchant@upi" }, { ...base })).toBe(false);
    expect(compareOutputs({ ...base }, { ...base, vpa: "merchant@upi" })).toBe(false);
  });

  it("returns false when a required field is missing", () => {
    const incomplete = { amount: 500, currency: "INR", date: "2026-07-12" };
    expect(compareOutputs(base, incomplete as typeof base)).toBe(false);
  });
});
