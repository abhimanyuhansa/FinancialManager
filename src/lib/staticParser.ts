// src/lib/staticParser.ts

export type StaticParseResult = {
  outcome: "parsed" | "not_transaction" | "insufficient_data";
  transactions: Array<{
    merchant: string;
    amount: number;
    currency: string;
    date: string;
    type: "expense" | "income";
    category: string;
    subCategory: string | null;
    confidence: number;
    needsReview: boolean;
    lineItems: null;
    vpa: string | null;
    vpaMerchantRaw: string | null;
  }>;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/,/g, "").trim());
  return isNaN(n) || n <= 0 ? null : n;
}

const MONTH_MAP: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05",
  june: "06", july: "07", august: "08", september: "09", october: "10",
  november: "11", december: "12", jan: "01", feb: "02", mar: "03",
  apr: "04", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10",
  nov: "11", dec: "12",
};

// Returns ISO date string. Includes time component only when found in `raw`.
// Never pads with midnight — if no time, returns YYYY-MM-DD only.
function normaliseDate(raw: string, fallback: string): string {
  // Extract optional trailing time "HH:MM:SS" or "HH:MM"
  const timeM = raw.match(/\s+(\d{2}:\d{2}(?::\d{2})?)$/);
  const time = timeM?.[1] ?? null;
  const datePart = timeM ? raw.slice(0, timeM.index).trim() : raw.trim();

  function withTime(date: string): string {
    return time ? `${date}T${time}` : date;
  }

  // DD/MM/YY or DD-MM-YY
  let m = datePart.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) return withTime(`20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);

  // DD-Mon-YY  e.g. 04-Jul-26
  m = datePart.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (m) {
    const mo = MONTH_MAP[m[2].toLowerCase()] ?? "01";
    return withTime(`20${m[3]}-${mo}-${m[1].padStart(2, "0")}`);
  }

  // "15 Jan, 2026"
  m = datePart.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTH_MAP[m[2].toLowerCase()] ?? "01";
    return withTime(`${m[3]}-${mo}-${m[1].padStart(2, "0")}`);
  }

  // "Jan 15, 2026" or "January 15, 2026"
  m = datePart.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTH_MAP[m[1].toLowerCase()] ?? "01";
    return withTime(`${m[3]}-${mo}-${m[2].padStart(2, "0")}`);
  }

  // YYYY-MM-DD already (with optional time already attached)
  if (/^\d{4}-\d{2}-\d{2}/.test(datePart)) return withTime(datePart.slice(0, 10));

  return fallback;
}

function categoryFromVpa(vpa: string, merchant: string): [string, string] {
  const t = (vpa + " " + merchant).toLowerCase();
  if (/zomato|swiggy|blinkit|zepto|bigbasket|dunzo|instamart|licious/.test(t)) return ["food", "delivery"];
  if (/amazon|flipkart|myntra|nykaa|ajio|meesho|snapdeal|ikea/.test(t)) return ["shopping", "general"];
  if (/uber|ola|rapido|yulu/.test(t)) return ["transport", "cab"];
  if (/irctc|railways/.test(t)) return ["transport", "train"];
  if (/indigo|airindia|spicejet|vistara|airasia/.test(t)) return ["travel", "flight"];
  if (/airtel|jio|bsnl|vodafone/.test(t)) return ["utilities", "mobile"];
  if (/netflix|spotify|prime|hotstar|zee5|sonyliv|youtube/.test(t)) return ["entertainment", "streaming"];
  if (/makemytrip|goibibo|oyo|agoda/.test(t)) return ["travel", "hotel"];
  if (/hospital|pharmacy|medplus|netmeds|1mg|apollo/.test(t)) return ["health", "pharmacy"];
  if (/electricity|bescom|msedcl|tneb|mahadiscom/.test(t)) return ["utilities", "electricity"];
  return ["other", "miscellaneous"];
}

function tx(
  merchant: string,
  amount: number,
  type: "expense" | "income",
  date: string,
  category: string,
  subCategory: string,
  opts: {
    confidence?: number;
    needsReview?: boolean;
    vpa?: string;
    vpaMerchantRaw?: string;
  } = {}
): StaticParseResult {
  return {
    outcome: "parsed",
    transactions: [{
      merchant: merchant.replace(/\s+/g, " ").trim(),
      amount, currency: "INR", date, type, category,
      subCategory, confidence: opts.confidence ?? 0.95,
      needsReview: opts.needsReview ?? false,
      lineItems: null,
      vpa: opts.vpa ?? null,
      vpaMerchantRaw: opts.vpaMerchantRaw ?? null,
    }],
  };
}

const NONE: StaticParseResult = { outcome: "not_transaction", transactions: [] };
const INSUF: StaticParseResult = { outcome: "insufficient_data", transactions: [] };

// ── Domain parsers ────────────────────────────────────────────────────────────

function parseHdfcUpiAlert(body: string, receivedDate: string): StaticParseResult {
  const amtDebit  = body.match(/Rs\.\s*([\d,]+(?:\.\d{1,2})?)\s+(?:is\s+debited|has been debited)/i);
  const amtCredit = body.match(/Rs\.\s*([\d,]+(?:\.\d{1,2})?)\s+is\s+(?:successfully\s+)?credited/i);
  const amtM = amtDebit ?? amtCredit;
  if (!amtM) return INSUF;
  const amount = parseAmount(amtM[1]);
  if (!amount) return INSUF;
  const type = amtCredit ? "income" : "expense";

  const vpaParenM = body.match(/(?:towards|to|by)\s+VPA\s+[\w.@\-]+\s+\(([^)]+)\)/i);
  const vpaAddrM  = body.match(/(?:towards|to|by)\s+VPA\s+([\w.@\-]+)/i);

  const vpa = vpaAddrM?.[1]?.toLowerCase() ?? null;
  let vpaMerchantRaw: string | null = null;
  let merchant = "Unknown";
  if (vpaParenM) {
    merchant = vpaParenM[1].trim();
    vpaMerchantRaw = vpaParenM[1].trim();
  } else if (vpa) {
    merchant = "Unknown";
  }

  const dateM = body.match(/on\s+(\d{2}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)\b/i);
  const date  = normaliseDate(dateM?.[1] ?? "", receivedDate);
  const [category, subCategory] = categoryFromVpa(vpa ?? "", merchant);

  return tx(merchant, amount, type, date, category, subCategory, {
    vpa: vpa ?? undefined,
    vpaMerchantRaw: vpaMerchantRaw ?? undefined,
    needsReview: merchant === "Unknown",
  });
}

function parseHdfcCreditCardAlert(body: string, receivedDate: string): StaticParseResult {
  const m = body.match(/Rs\.\s*([\d,]+(?:\.\d{1,2})?)\s+is debited from your HDFC Bank Credit Card ending\s+\d+\s+towards\s+(.+?)\s+on\s+(\d+\s+\w{3},\s+\d{4})/i);
  if (!m) return INSUF;
  const amount = parseAmount(m[1]);
  if (!amount) return INSUF;
  const merchant = m[2].trim();
  const date = normaliseDate(m[3], receivedDate);
  const [category, subCategory] = categoryFromVpa("", merchant);
  return tx(merchant, amount, "expense", date, category, subCategory);
}

function parseSbiAlert(body: string, receivedDate: string): StaticParseResult {
  const debitM  = body.match(/Debited\s+INR\s+([\d,]+(?:\.\d{2})?)/i);
  const creditM = body.match(/Credited\s+INR\s+([\d,]+(?:\.\d{2})?)/i);
  if (!debitM && !creditM) return INSUF;
  const amount = parseAmount((debitM ?? creditM)![1]);
  if (!amount) return INSUF;
  const type = creditM ? "income" : "expense";
  const toM = body.match(/Transferred to\s+((?:Mr\.|Mrs\.|Ms\.)?\s*[A-Z][A-Z\s]+)/i);
  const merchant = toM?.[1]?.trim() ?? "SBI Transfer";
  const dateM = body.match(/on\s+(\d{2}\/\d{2}\/\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/i);
  const date = normaliseDate(dateM?.[1] ?? "", receivedDate);
  return tx(merchant, amount, type, date, "finance", "bank_transfer");
}

function parseDcbBank(body: string, receivedDate: string): StaticParseResult {
  const debitM  = body.match(/was debited with INR\s+([\d,]+(?:\.\d{2})?)/i);
  const creditM = body.match(/was credited with INR\s+([\d,]+(?:\.\d{2})?)/i);
  if (!debitM && !creditM) return INSUF;
  const amount = parseAmount((debitM ?? creditM)![1]);
  if (!amount) return INSUF;
  const type = creditM ? "income" : "expense";
  const narM = body.match(/at\s+(?:VS|POS|UPI)\/[\d\w\/]+?\/([A-Z][A-Z\s&.]+?)(?:\s+Available|\s*$)/i);
  const merchant = narM?.[1]?.trim() ?? "DCB Bank";
  const dateM = body.match(/on\s+(\d{2}-\d{2}-\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/i);
  let date = receivedDate;
  if (dateM) {
    // DD-MM-YYYY → normaliseDate can't handle this format directly; rewrite to DD/MM/YY then delegate
    const [dd, mm, yyyy, ...rest] = dateM[1].split(/[-\s]/);
    const yy = yyyy.slice(2);
    const timeStr = rest.length ? ` ${rest.join(" ")}` : "";
    date = normaliseDate(`${dd}/${mm}/${yy}${timeStr}`, receivedDate);
  }
  const [category, subCategory] = categoryFromVpa("", merchant);
  return tx(merchant, amount, type, date, category, subCategory);
}

function parseIciciAlert(body: string, receivedDate: string): StaticParseResult {
  const creditM = body.match(/Account\s+\w+\s+has been credited with INR\s+([\d,]+(?:\.\d{2})?)\s+on\s+(\d{2}-[A-Za-z]{3}-\d{2})/i);
  const debitM  = body.match(/Account\s+\w+\s+has been debited with INR\s+([\d,]+(?:\.\d{2})?)\s+on\s+(\d{2}-[A-Za-z]{3}-\d{2})/i);
  if (!creditM && !debitM) return INSUF;
  const m = creditM ?? debitM!;
  const amount = parseAmount(m[1]);
  if (!amount) return INSUF;
  const type = creditM ? "income" : "expense";
  const date = normaliseDate(m[2], receivedDate);
  return tx("ICICI Bank", amount, type, date, "finance", type === "income" ? "bank_interest" : "bank_transfer");
}

function parseAmazonPay(body: string, subject: string, receivedDate: string): StaticParseResult {
  const subjectPayM = subject.match(/payment of\s*[₹]\s*([\d,]+(?:\.\d{1,2})?)\s+to\s+([A-Za-z0-9 &\-']+?)\s+was successful/i);
  if (subjectPayM) {
    const amount = parseAmount(subjectPayM[1]);
    if (!amount) return INSUF;
    const merchant = subjectPayM[2].trim();
    const dateM = body.match(/Payment date:\s+\w+,\s+(\d{1,2}\s+\w{3,9},?\s*\d{4})/i);
    const date = normaliseDate(dateM?.[1] ?? "", receivedDate);
    const mLow = merchant.toLowerCase();
    let category = "shopping";
    let subCategory = "general";
    if (/zepto|bigbasket|blinkit|swiggy|zomato|instamart/.test(mLow)) {
      category = "groceries";
      subCategory = "online_grocery";
    } else if (/uber|ola/.test(mLow)) {
      category = "transport";
      subCategory = "cab";
    }
    return tx(merchant, amount, "expense", date, category, subCategory);
  }

  const bodyMerchantM = body.match(/payment to\s+([A-Za-z0-9 &\-']+?)\s+is Approved/i);
  const bodyAmtM      = body.match(/Amount[:\s]+[₹]\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (bodyMerchantM && bodyAmtM) {
    const amount = parseAmount(bodyAmtM[1]);
    if (!amount) return INSUF;
    const merchant = bodyMerchantM[1].trim();
    const dateM = body.match(/Payment date:\s+\w+,\s+(\d{1,2}\s+\w{3,9},?\s*\d{4})/i);
    const date = normaliseDate(dateM?.[1] ?? "", receivedDate);
    return tx(merchant, amount, "expense", date, "shopping", "general");
  }

  return NONE;
}

function parseSwiggy(body: string, subject: string, receivedDate: string): StaticParseResult {
  if (!/(?:order was (?:successfully )?delivered|order was delivered (?:superfast|on time|before time)|gourmet order was|dineout payment was successful)/i.test(subject)) {
    return NONE;
  }

  const isDineout = /dineout/i.test(subject);
  let amount: number | null = null;

  if (isDineout) {
    const m = body.match(/Dineout payment of INR\s+([\d,]+(?:\.\d{2})?)/i)
           ?? body.match(/Total Paid\s+[₹]([\d,]+(?:\.\d{2})?)/i);
    amount = parseAmount(m?.[1]);
  } else {
    const paidM  = body.match(/Paid Via[^₹\n]*[₹]\s*([\d,]+(?:\.\d{2})?)/i);
    const grandM = body.match(/Grand Total\s+[₹]?\s*([\d,]+(?:\.\d{2})?)/i);
    const orderM = body.match(/Order Total\s*[:\s]*[₹]?\s*([\d,]+(?:\.\d{2})?)/i);
    const itemM  = body.match(/Item Total:\s*[₹]\s*([\d,]+(?:\.\d{2})?)/i);
    amount = parseAmount(paidM?.[1] ?? grandM?.[1] ?? orderM?.[1] ?? itemM?.[1]);
  }
  if (!amount) return INSUF;

  const restM = body.match(/Ordered from:\s+(.+?)(?:\s+Opposite|\s+Shop|,|\n)/i)
             ?? body.match(/Restaurant\s+([A-Za-z][^\n]{3,50}?)(?:\s+Your Order Summary|\s+Order No:)/i);
  const merchant = restM?.[1]?.trim() ?? "Swiggy";

  const dateM = body.match(/Order (?:placed|Time and Date)[:\s]+(?:\w+,\s+)?(.+?)(?:\n|$)/i);
  let date = receivedDate;
  if (dateM) {
    const raw = dateM[1].trim().replace(/\s+\d{1,2}:\d{2}\s*(?:AM|PM).*/, "").trim();
    date = normaliseDate(raw, receivedDate);
  }

  return tx(merchant, amount, "expense", date, "food", isDineout ? "restaurants" : "delivery");
}

function parseZomato(body: string, subject: string, receivedDate: string): StaticParseResult {
  const amtM = body.match(/Total paid\s*[-–]\s*[₹]([\d,]+(?:\.\d{2})?)/i);
  const amount = parseAmount(amtM?.[1]);
  if (!amount) return NONE;
  const restM = body.match(/Thank you for ordering from\s+(.+?)(?:\s+ORDER ID|\s*\n)/i)
             ?? subject.match(/Your Zomato order from (.+)/i);
  const merchant = restM?.[1]?.trim() ?? "Zomato";
  return tx(merchant, amount, "expense", receivedDate, "food", "delivery");
}

function parseUber(body: string, subject: string, receivedDate: string): StaticParseResult {
  if (!/trip with Uber|receipt for your|delivery.*receipt/i.test(subject)) return NONE;
  const amtM = body.match(/Total\s+[₹]([\d,]+(?:\.\d{2})?)/i);
  const amount = parseAmount(amtM?.[1]);
  if (!amount) return INSUF;
  const isDelivery = /delivery/i.test(subject);
  const dateM = body.match(/(\w{3,9}\s+\d{1,2},\s+\d{4})/);
  const date  = normaliseDate(dateM?.[1] ?? "", receivedDate);
  return tx("Uber", amount, "expense", date, isDelivery ? "food" : "transport", isDelivery ? "delivery" : "cab");
}

function parseAirtel(body: string, subject: string, receivedDate: string): StaticParseResult {
  const isReceipt = /payment receipt/i.test(subject);
  const amtM = isReceipt
    ? body.match(/payment of Rs\s+([\d,]+(?:\.\d{2})?)/i)
    : body.match(/Total amount payable:\s*([\d,]+(?:\.\d{2})?)/i);
  const amount = parseAmount(amtM?.[1]);
  if (!amount) return INSUF;
  const dateM = body.match(/Statement Date\s+(\d{1,2}\s+\w{3,9}\s+\d{4})/i)
             ?? body.match(/Due Date:\s*(\d{1,2}\s+\w{3,9}\s+\d{4})/i);
  const date = normaliseDate(dateM?.[1] ?? "", receivedDate);
  const subCategory = /broadband|fiber|black/i.test(body) ? "broadband" : "mobile";
  return tx("Airtel", amount, "expense", date, "utilities", subCategory);
}

function parseJio(body: string, subject: string, receivedDate: string): StaticParseResult {
  if (!/payment receipt|payment.*received/i.test(subject)) return NONE;
  const amtM = body.match(/payment of Rs\.?\s*([\d,]+(?:\.\d{2})?)/i);
  const amount = parseAmount(amtM?.[1]);
  if (!amount) return INSUF;
  const dateM = body.match(/on\s+(\d{2}-[A-Za-z]{3}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/i);
  const date  = normaliseDate(dateM?.[1] ?? "", receivedDate);
  return tx("Jio", amount, "expense", date, "utilities", "mobile");
}

function parseMsedcl(body: string, subject: string, receivedDate: string): StaticParseResult {
  if (!/payment receipt|online payment receipt/i.test(subject)) return NONE;
  const amtM = body.match(/Amount:\s*([\d,]+)\s*\/-/i);
  const amount = parseAmount(amtM?.[1]);
  if (!amount) return INSUF;
  // Date can be M/DD/YYYY or DD/MM/YYYY — disambiguate by checking if p2 > 12
  const dateM = body.match(/Transaction Date[^:]*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  let date = receivedDate;
  if (dateM) {
    const [, p1, p2, y] = dateM;
    const d2 = parseInt(p2);
    if (d2 > 12) {
      date = `${y}-${p1.padStart(2, "0")}-${p2.padStart(2, "0")}`; // M/DD
    } else {
      date = `${y}-${p2.padStart(2, "0")}-${p1.padStart(2, "0")}`; // DD/MM
    }
  }
  return tx("MSEDCL (Electricity)", amount, "expense", date, "utilities", "electricity");
}

function parseCred(body: string, subject: string, receivedDate: string): StaticParseResult {
  if (!/credit card bill payment was successful/i.test(subject)) return NONE;
  const amtM = body.match(/amount paid\s*[₹]([\d,]+(?:\.\d{2})?)/i);
  const amount = parseAmount(amtM?.[1]);
  if (!amount) return INSUF;
  const dateM = body.match(/payment date\s+(\w{3,9}\s+\d{2},\s+\d{4})/i);
  const date  = normaliseDate(dateM?.[1] ?? "", receivedDate);
  const cardM = body.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Bank|BANK))\s+[•.]{4}\s+(\d{4})/);
  const merchant = cardM ? `${cardM[1]} •••• ${cardM[2]}` : "Credit Card";
  return tx(merchant, amount, "expense", date, "finance", "credit_card_payment");
}

function parseGoIndigo(body: string, receivedDate: string): StaticParseResult {
  const amtM = body.match(/(?:Total Amount|Grand Total|Amount Paid|Total Fare)\s*[:\s]*(?:INR|[₹])\s*([\d,]+(?:\.\d{2})?)/i)
             ?? body.match(/INR\s*([\d,]+(?:\.\d{2})?)/i);
  const amount = parseAmount(amtM?.[1]);
  if (!amount) return INSUF;
  return tx("IndiGo", amount, "expense", receivedDate, "travel", "flight");
}

// ── Domains that are never financial ─────────────────────────────────────────

const SKIP_DOMAINS = new Set([
  "linkedin.com", "reply.experteer.co.uk", "getujobs.com", "google.com",
  "accounts.google.com", "zoom.us", "economictimesnews.com", "github.com",
  "getonecard.app", "nobrokerhood.com", "jobs.simplyhired.com",
  "candidates.workablemail.com", "timesjobs.com", "applytojob.com",
  "leetcode.com", "vercel.com", "careers.bytedance.com", "smartrecruiters.com",
  "online.hdfclife.com", "custcomm.icicibank.com", "kotak.bank.in",
  "mailers.hdfcbank.bank.in",
]);

// ── Main export ───────────────────────────────────────────────────────────────

export type EmailInput = {
  body: string;
  senderName: string;
  senderDomain: string;
  senderEmail: string;
  subject: string;
  receivedDate: string;
};

export function parseEmailStatic(email: EmailInput): StaticParseResult {
  const { body, senderDomain, subject, receivedDate } = email;

  if (SKIP_DOMAINS.has(senderDomain)) return NONE;

  switch (senderDomain) {
    case "hdfcbank.bank.in":
      return parseHdfcUpiAlert(body, receivedDate);

    case "hdfcbank.net":
    case "mailers.hdfcbank.net": {
      if (/has been debited from account|is debited from your account|is successfully credited/i.test(body)) {
        return parseHdfcUpiAlert(body, receivedDate);
      }
      if (/is debited from your HDFC Bank Credit Card/i.test(body)) {
        return parseHdfcCreditCardAlert(body, receivedDate);
      }
      return NONE;
    }

    case "alerts.sbi.bank.in":
    case "communications.sbi.co.in":
      return parseSbiAlert(body, receivedDate);

    case "dcbbank.com":
      return parseDcbBank(body, receivedDate);

    case "icici.bank.in":
    case "custcomm.icici.bank.in":
      return parseIciciAlert(body, receivedDate);

    case "amazonpay.in":
      return parseAmazonPay(body, subject, receivedDate);

    case "swiggy.in":
      return parseSwiggy(body, subject, receivedDate);

    case "zomato.com":
      return parseZomato(body, subject, receivedDate);

    case "uber.com":
      return parseUber(body, subject, receivedDate);

    case "airtel.com":
      return parseAirtel(body, subject, receivedDate);

    case "jio.com":
      return parseJio(body, subject, receivedDate);

    case "mahadiscom.in":
      return parseMsedcl(body, subject, receivedDate);

    case "cred.club":
      return parseCred(body, subject, receivedDate);

    case "customer.goindigo.in":
    case "goindigo.in":
      return parseGoIndigo(body, receivedDate);

    default:
      return INSUF;
  }
}
