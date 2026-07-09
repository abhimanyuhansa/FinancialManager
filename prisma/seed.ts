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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
