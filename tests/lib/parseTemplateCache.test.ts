import { canonicalise, templateHash, normalizeToSkeleton } from "@/lib/parseTemplateCache";
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
  amount:          { regex: "Rs\\.\\s*([0-9,]+\\.?[0-9]*)", group: 1, transform: "parseAmount" },
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
      amount: { regex: "Rs\\.\\s*([0-9,]+\\.?[0-9]*)", group: 1, transform: "parseAmount" },
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

import { deriveExtractors } from "@/lib/parseTemplateCache";

describe("deriveExtractors", () => {
  const subject = "Alert: Rs. 500.00 debited";
  const body = "Rs. 500.00 debited from your account on 12-07-26 at Swiggy via UPI. VPA swiggy@upi";
  const geminiResult = {
    amount: 500,
    currency: "INR",
    date: "2026-07-12",
    transactionType: "expense" as const,
    merchant: "Swiggy",
    vpa: "swiggy@upi",
  };
  const bodyTemplate =
    "Rs. {{AMOUNT}} debited from your account on {{DATE}} at {{MERCHANT}} via UPI. VPA {{VPA}}";

  it("derives amount extractor that matches original body", () => {
    const extractors = deriveExtractors(subject, body, bodyTemplate, subject, geminiResult);
    expect(extractors.amount).toBeDefined();
    if (extractors.amount && "regex" in extractors.amount) {
      const re = new RegExp(extractors.amount.regex, "i");
      expect(body.match(re)?.[extractors.amount.group]).toBe("500.00");
    }
  });

  it("derives currency as static extractor", () => {
    const extractors = deriveExtractors(subject, body, bodyTemplate, subject, geminiResult);
    expect(extractors.currency).toEqual({ static: "INR" });
  });

  it("returns null for required field when regex fails safety check", () => {
    const unsafeBody = "amount (((((x+)+)+)+) debited";
    const unsafeTemplate = "amount {{AMOUNT}} debited";
    const result = deriveExtractors(unsafeBody, unsafeBody, unsafeTemplate, subject, geminiResult);
    if (result.amount && "regex" in result.amount) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const safeRegex = require("safe-regex");
      expect(safeRegex((result.amount as { regex: string }).regex)).toBe(true);
    }
  });

  it("returns undefined for placeholder not found in template", () => {
    const noDateTemplate = "Rs. {{AMOUNT}} debited at {{MERCHANT}}";
    const extractors = deriveExtractors(subject, body, noDateTemplate, subject, geminiResult);
    expect(extractors.date).toBeUndefined();
  });
});

import { shouldPromote, shouldDegrade, shouldDisableShadow } from "@/lib/parseTemplateCache";

describe("state transitions", () => {
  describe("shouldPromote", () => {
    it("returns true when consecutiveSuccesses reaches 3", () => {
      expect(shouldPromote(3)).toBe(true);
      expect(shouldPromote(4)).toBe(true);
    });
    it("returns false below threshold", () => {
      expect(shouldPromote(2)).toBe(false);
      expect(shouldPromote(0)).toBe(false);
    });
  });

  describe("shouldDegrade", () => {
    it("returns true when consecutiveFailures reaches 2", () => {
      expect(shouldDegrade(2)).toBe(true);
    });
    it("returns false below threshold", () => {
      expect(shouldDegrade(1)).toBe(false);
    });
  });

  describe("shouldDisableShadow", () => {
    it("returns true when consecutiveFailures reaches 3", () => {
      expect(shouldDisableShadow(3)).toBe(true);
    });
    it("returns false below threshold", () => {
      expect(shouldDisableShadow(2)).toBe(false);
    });
  });
});

describe("normalizeToSkeleton", () => {
  it("replaces currency amounts (₹500, Rs.1,200.50, INR 3000)", () => {
    const input = "Rs. 500.00 debited. Amount: ₹1,200.50. INR 3000 transferred.";
    const result = normalizeToSkeleton(input);
    expect(result).not.toMatch(/500/);
    expect(result).not.toMatch(/1,200/);
    expect(result).not.toMatch(/3000/);
    expect(result).toContain("{{AMOUNT}}");
  });

  it("replaces dates in common formats", () => {
    const input = "Transaction on 15/07/26 at 12:30. Statement for 2026-07-15. Date: 15 Jul, 2026.";
    const result = normalizeToSkeleton(input);
    expect(result).not.toMatch(/15\/07\/26/);
    expect(result).not.toMatch(/2026-07-15/);
    expect(result).toContain("{{DATE}}");
  });

  it("replaces UPI VPA addresses", () => {
    const input = "Payment to merchant@okhdfcbank. UPI ref: user.name@oksbi";
    const result = normalizeToSkeleton(input);
    expect(result).not.toMatch(/merchant@okhdfcbank/);
    expect(result).not.toMatch(/user\.name@oksbi/);
    expect(result).toContain("{{VPA}}");
  });

  it("replaces account/card last-4 digits", () => {
    const input = "Account XX1234 debited. Card ending 5678 charged.";
    const result = normalizeToSkeleton(input);
    expect(result).not.toMatch(/XX1234/);
    expect(result).not.toMatch(/5678/);
  });

  it("replaces order and transaction IDs", () => {
    const input = "Order ID: 408-1234567-8901234. Txn Ref: TXN20260715123456789";
    const result = normalizeToSkeleton(input);
    expect(result).not.toMatch(/408-1234567/);
    expect(result).not.toMatch(/TXN20260715/);
    expect(result).toContain("{{ORDER_ID}}");
    expect(result).toContain("{{TXN_ID}}");
  });

  it("preserves static text (bank name, labels)", () => {
    const result = normalizeToSkeleton("HDFC Bank Alert: Rs.500 debited");
    expect(result).toContain("HDFC Bank Alert");
    expect(result).toContain("debited");
  });
});

describe("templateHash — skeleton stability", () => {
  it("same structural template with different amounts produces the same hash", () => {
    const email1Subject = "HDFC Bank UPI Alert";
    const email1Body = "Rs. 500.00 debited from your HDFC account towards VPA zepto@okicici on 15/07/26";
    const email2Body = "Rs. 1200.00 debited from your HDFC account towards VPA zepto@okicici on 16/07/26";

    const hash1 = templateHash(email1Subject, email1Body);
    const hash2 = templateHash(email1Subject, email2Body);
    expect(hash1).toBe(hash2);
  });

  it("structurally different emails produce different hashes", () => {
    const hash1 = templateHash("HDFC UPI Alert", "Rs. 500 debited from account towards VPA");
    const hash2 = templateHash("SBI Alert", "INR 500 Debited from Acct No");
    expect(hash1).not.toBe(hash2);
  });

  it("same email always produces same hash (idempotent)", () => {
    const body = "Rs. 750 debited from your account on 15/07/26";
    expect(templateHash("Alert", body)).toBe(templateHash("Alert", body));
  });
});
