import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { WebSocket } from "ws";
import { config } from "dotenv";
import { neonConfig } from "@neondatabase/serverless";

config({ path: ".env.local" });

neonConfig.webSocketConstructor = WebSocket;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);

const filters = [
  // ── Banks (sourceRank 1) ──────────────────────────────────────────────────
  { type: "sender_domain", value: "hdfcbank.com",        sourceRank: 1, note: "HDFC Bank alerts" },
  { type: "sender_domain", value: "icicibank.com",       sourceRank: 1, note: "ICICI Bank alerts" },
  { type: "sender_domain", value: "axisbank.com",        sourceRank: 1, note: "Axis Bank alerts" },
  { type: "sender_domain", value: "sbi.co.in",           sourceRank: 1, note: "SBI alerts" },
  { type: "sender_domain", value: "kotakbank.com",       sourceRank: 1, note: "Kotak Mahindra Bank" },
  { type: "sender_domain", value: "indusind.com",        sourceRank: 1, note: "IndusInd Bank" },
  { type: "sender_domain", value: "yesbank.in",          sourceRank: 1, note: "Yes Bank" },
  { type: "sender_domain", value: "idfcfirstbank.com",   sourceRank: 1, note: "IDFC First Bank" },
  { type: "sender_domain", value: "federalbank.co.in",   sourceRank: 1, note: "Federal Bank" },
  { type: "sender_domain", value: "rblbank.com",         sourceRank: 1, note: "RBL Bank" },
  { type: "sender_domain", value: "aubank.in",           sourceRank: 1, note: "AU Small Finance Bank" },
  { type: "sender_domain", value: "sc.com",              sourceRank: 1, note: "Standard Chartered" },
  { type: "sender_domain", value: "hsbc.co.in",          sourceRank: 1, note: "HSBC India" },
  { type: "sender_domain", value: "citibank.com",        sourceRank: 1, note: "Citi India" },
  { type: "sender_email",  value: "alerts@axisbank.com", sourceRank: 1, note: "Axis Bank specific alert sender" },
  { type: "sender_email",  value: "noreply@hdfcbank.com",sourceRank: 1, note: "HDFC noreply" },

  // ── Payment Gateways (sourceRank 2) ──────────────────────────────────────
  { type: "sender_domain", value: "gpay.com",            sourceRank: 2, note: "Google Pay" },
  { type: "sender_email",  value: "noreply@google.com",  sourceRank: 2, note: "Google Pay receipts" },
  { type: "sender_domain", value: "phonepe.com",         sourceRank: 2, note: "PhonePe" },
  { type: "sender_domain", value: "paytm.com",           sourceRank: 2, note: "Paytm" },
  { type: "sender_domain", value: "amazonpay.in",        sourceRank: 2, note: "Amazon Pay" },
  { type: "sender_domain", value: "mobikwik.com",        sourceRank: 2, note: "MobiKwik" },
  { type: "sender_domain", value: "freecharge.in",       sourceRank: 2, note: "FreeCharge" },
  { type: "sender_domain", value: "razorpay.com",        sourceRank: 2, note: "Razorpay receipts" },

  // ── Merchants (sourceRank 3) ──────────────────────────────────────────────
  { type: "sender_domain", value: "swiggy.in",           sourceRank: 3, note: "Swiggy orders" },
  { type: "sender_domain", value: "zomato.com",          sourceRank: 3, note: "Zomato orders" },
  { type: "sender_domain", value: "amazon.in",           sourceRank: 3, note: "Amazon India orders" },
  { type: "sender_domain", value: "flipkart.com",        sourceRank: 3, note: "Flipkart orders" },
  { type: "sender_domain", value: "myntra.com",          sourceRank: 3, note: "Myntra orders" },
  { type: "sender_domain", value: "bigbasket.com",       sourceRank: 3, note: "BigBasket orders" },
  { type: "sender_domain", value: "blinkit.com",         sourceRank: 3, note: "Blinkit orders" },
  { type: "sender_domain", value: "nykaa.com",           sourceRank: 3, note: "Nykaa orders" },
  { type: "sender_domain", value: "uber.com",            sourceRank: 3, note: "Uber rides" },
  { type: "sender_domain", value: "olacabs.com",         sourceRank: 3, note: "Ola rides" },
  { type: "sender_domain", value: "rapido.bike",         sourceRank: 3, note: "Rapido rides" },
  { type: "sender_domain", value: "irctc.co.in",         sourceRank: 3, note: "IRCTC train tickets" },
  { type: "sender_domain", value: "makemytrip.com",      sourceRank: 3, note: "MakeMyTrip bookings" },
  { type: "sender_domain", value: "cleartrip.com",       sourceRank: 3, note: "Cleartrip bookings" },
  { type: "sender_domain", value: "ixigo.com",           sourceRank: 3, note: "Ixigo bookings" },
  { type: "sender_domain", value: "netflix.com",         sourceRank: 3, note: "Netflix subscription" },
  { type: "sender_domain", value: "hotstar.com",         sourceRank: 3, note: "Hotstar subscription" },
  { type: "sender_domain", value: "primevideo.com",      sourceRank: 3, note: "Amazon Prime Video" },
  { type: "sender_domain", value: "spotify.com",         sourceRank: 3, note: "Spotify subscription" },
  { type: "sender_domain", value: "bookmyshow.com",      sourceRank: 3, note: "BookMyShow tickets" },

  // ── Subject keywords (catch-all for unknown senders) ─────────────────────
  { type: "subject_keyword", value: "debited",           sourceRank: 1, note: "Bank debit keyword" },
  { type: "subject_keyword", value: "credited",          sourceRank: 1, note: "Bank credit keyword" },
  { type: "subject_keyword", value: "transaction alert", sourceRank: 1, note: "Transaction alert keyword" },
  { type: "subject_keyword", value: "payment of",        sourceRank: 2, note: "Payment confirmation keyword" },
  { type: "subject_keyword", value: "payment successful",sourceRank: 2, note: "Payment success keyword" },
  { type: "subject_keyword", value: "amount deducted",   sourceRank: 1, note: "Deduction keyword" },
  { type: "subject_keyword", value: "order confirmed",   sourceRank: 3, note: "Order confirmation keyword" },
  { type: "subject_keyword", value: "invoice",           sourceRank: 3, note: "Invoice keyword" },
  { type: "subject_keyword", value: "statement",         sourceRank: 1, note: "Statement keyword (for reconciliation)" },
];

const fromKeywords = [
  "hdfcbank", "icicibank", "axisbank", "sbi", "kotak", "indusind", "yesbank", "paytm", "gpay",
  "phonepe", "amazonpay", "swiggy", "zomato", "blinkit", "zepto", "bigbasket", "groww",
  "zerodha", "upstox", "irctc", "indigo", "makemytrip", "goibibo", "ola", "uber", "myntra",
  "nykaa", "ajio", "noreply", "no-reply", "alert", "alerts", "notify", "notification",
  "notifications", "billing", "billings", "invoice", "invoices", "statement", "statements",
  "payment", "payments", "paid", "transaction", "transactions", "receipt", "receipts", "bill",
  "bills", "debit", "debits", "credit", "credits", "debited", "credited", "charge", "charges",
  "charged", "purchase", "purchases", "purchased", "order", "orders", "booking", "bookings",
  "refund", "refunds", "cashback", "amount", "amounts", "emi", "emis", "due", "transfer",
  "transfers", "upi", "neft", "imps", "rtgs", "reward", "rewards", "dividend", "dividends",
  "salary", "investment", "investments",
];

const subjectKeywords = [
  "payment", "payments", "paid", "transaction", "transactions", "receipt", "receipts",
  "invoice", "invoices", "bill", "bills", "statement", "statements", "debit", "debits",
  "credit", "credits", "debited", "credited", "charge", "charges", "charged", "purchase",
  "purchases", "purchased", "order", "orders", "booking", "bookings", "refund", "refunds",
  "cashback", "amount", "amounts", "emi", "emis", "due", "transfer", "transfers", "upi", "neft",
  "imps", "rtgs", "reward", "rewards", "dividend", "dividends", "salary", "investment",
  "investments", "hdfcbank", "icicibank", "axisbank", "sbi", "kotak", "indusind", "yesbank",
  "paytm", "gpay", "phonepe", "amazonpay", "swiggy", "zomato", "blinkit", "zepto", "bigbasket",
  "groww", "zerodha", "upstox", "irctc", "indigo", "makemytrip", "goibibo", "ola", "uber",
  "myntra", "nykaa", "ajio", "noreply", "no-reply", "alert", "alerts", "notify", "notification",
  "notifications", "billing", "billings",
];

const exclusionDomains = [
  { value: "linkedin.com", note: "LinkedIn job notifications" },
  { value: "naukri.com", note: "Naukri job alerts" },
  { value: "simplyhired.com", note: "SimplyHired job alerts" },
  { value: "indeed.com", note: "Indeed job alerts" },
  { value: "glassdoor.com", note: "Glassdoor job alerts" },
  { value: "monster.com", note: "Monster job alerts" },
  { value: "experteer.com", note: "Experteer job alerts" },
  { value: "shine.com", note: "Shine job alerts" },
  { value: "timesjobs.com", note: "TimesJobs job alerts" },
  { value: "foundit.in", note: "Foundit job alerts" },
  { value: "zoom.us", note: "Zoom meeting notifications" },
  { value: "calendly.com", note: "Calendly scheduling notifications" },
  { value: "medium.com", note: "Medium newsletters" },
  { value: "substack.com", note: "Substack newsletters" },
];

const subCategories: { category: string; subCategory: string }[] = [
  // food
  { category: "food", subCategory: "restaurants" },
  { category: "food", subCategory: "food delivery" },
  { category: "food", subCategory: "grocery" },
  { category: "food", subCategory: "bakery" },
  { category: "food", subCategory: "snacks" },
  { category: "food", subCategory: "alcohol" },
  { category: "food", subCategory: "hookah" },
  // transport
  { category: "transport", subCategory: "cab" },
  { category: "transport", subCategory: "metro" },
  { category: "transport", subCategory: "bus" },
  { category: "transport", subCategory: "train" },
  { category: "transport", subCategory: "flight" },
  { category: "transport", subCategory: "fuel" },
  { category: "transport", subCategory: "parking" },
  { category: "transport", subCategory: "toll" },
  // shopping
  { category: "shopping", subCategory: "clothing" },
  { category: "shopping", subCategory: "electronics" },
  { category: "shopping", subCategory: "home" },
  { category: "shopping", subCategory: "beauty" },
  { category: "shopping", subCategory: "pharmacy" },
  { category: "shopping", subCategory: "books" },
  // entertainment
  { category: "entertainment", subCategory: "streaming" },
  { category: "entertainment", subCategory: "gaming" },
  { category: "entertainment", subCategory: "events" },
  { category: "entertainment", subCategory: "movies" },
  { category: "entertainment", subCategory: "sports" },
  // utilities
  { category: "utilities", subCategory: "electricity" },
  { category: "utilities", subCategory: "water" },
  { category: "utilities", subCategory: "gas" },
  { category: "utilities", subCategory: "internet" },
  { category: "utilities", subCategory: "mobile" },
  { category: "utilities", subCategory: "cable" },
  // health
  { category: "health", subCategory: "hospital" },
  { category: "health", subCategory: "pharmacy" },
  { category: "health", subCategory: "lab tests" },
  { category: "health", subCategory: "fitness" },
  { category: "health", subCategory: "insurance" },
  // finance
  { category: "finance", subCategory: "credit card" },
  { category: "finance", subCategory: "emi" },
  { category: "finance", subCategory: "investment" },
  { category: "finance", subCategory: "insurance premium" },
  { category: "finance", subCategory: "bank charges" },
  // travel
  { category: "travel", subCategory: "hotel" },
  { category: "travel", subCategory: "flight" },
  { category: "travel", subCategory: "train" },
  { category: "travel", subCategory: "activities" },
  // groceries
  { category: "groceries", subCategory: "vegetables" },
  { category: "groceries", subCategory: "fruits" },
  { category: "groceries", subCategory: "dairy" },
  { category: "groceries", subCategory: "meat" },
  { category: "groceries", subCategory: "staples" },
  { category: "groceries", subCategory: "beverages" },
  // income
  { category: "income", subCategory: "salary" },
  { category: "income", subCategory: "freelance" },
  { category: "income", subCategory: "dividend" },
  { category: "income", subCategory: "interest" },
  { category: "income", subCategory: "rental" },
  { category: "income", subCategory: "refund" },
];

async function main() {
  console.log("Seeding EmailFilter table...");

  let created = 0;
  let skipped = 0;

  for (const filter of filters) {
    const result = await prisma.emailFilter.upsert({
      where: { type_value: { type: filter.type, value: filter.value } },
      update: {},
      create: filter,
    });
    if (result.addedAt.toISOString() === result.addedAt.toISOString()) {
      created++;
    } else {
      skipped++;
    }
  }

  console.log(`Done. ${filters.length} filters processed (${created} upserted, ${skipped} skipped).`);

  // ── GmailQueryKeyword ────────────────────────────────────────────────────
  console.log("Seeding GmailQueryKeyword...");
  for (const value of fromKeywords) {
    await prisma.gmailQueryKeyword.upsert({
      where: { type_value: { type: "from", value } },
      update: {},
      create: { type: "from", value, isDefault: true },
    });
  }
  for (const value of subjectKeywords) {
    await prisma.gmailQueryKeyword.upsert({
      where: { type_value: { type: "subject", value } },
      update: {},
      create: { type: "subject", value, isDefault: true },
    });
  }
  console.log(`GmailQueryKeyword: ${fromKeywords.length} from + ${subjectKeywords.length} subject keywords seeded.`);

  // ── ExclusionRule ────────────────────────────────────────────────────────
  console.log("Seeding ExclusionRule...");
  for (const { value, note } of exclusionDomains) {
    await prisma.exclusionRule.upsert({
      where: { type_value: { type: "sender_domain", value } },
      update: {},
      create: { type: "sender_domain", value, note },
    });
  }
  console.log(`ExclusionRule: ${exclusionDomains.length} noise domains seeded.`);

  // ── SubCategoryMaster ────────────────────────────────────────────────────
  console.log("Seeding SubCategoryMaster...");
  for (const { category, subCategory } of subCategories) {
    await prisma.subCategoryMaster.upsert({
      where: { category_subCategory: { category, subCategory } },
      update: {},
      create: { category, subCategory, isDefault: true, addedBy: "system" },
    });
  }
  console.log(`SubCategoryMaster: ${subCategories.length} entries seeded.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
