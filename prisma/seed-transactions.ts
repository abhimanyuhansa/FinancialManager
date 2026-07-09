import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { WebSocket } from "ws";
import { config } from "dotenv";
import { neonConfig } from "@neondatabase/serverless";

config({ path: ".env.local" });
neonConfig.webSocketConstructor = WebSocket;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter } as ConstructorParameters<typeof PrismaClient>[0]);

// Real user ID from the app (cmrdfp3bv0000snk9ueijkn6u)
const USER_ID = process.argv[2];
if (!USER_ID) {
  console.error("Usage: npx tsx prisma/seed-transactions.ts <userId>");
  process.exit(1);
}

const now = new Date();
const d = (daysAgo: number) => {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  return date;
};

const transactions = [
  // Income
  { merchant: "Salary - Company", amount: 85000, type: "income", category: "income", date: d(2), sourceRank: 1 },
  { merchant: "Freelance Project", amount: 15000, type: "income", category: "income", date: d(10), sourceRank: 2 },
  // Food
  { merchant: "Swiggy", amount: 450, type: "expense", category: "food", date: d(1) },
  { merchant: "Zomato", amount: 320, type: "expense", category: "food", date: d(3) },
  { merchant: "Starbucks", amount: 580, type: "expense", category: "cafe", date: d(4) },
  { merchant: "BigBasket", amount: 2200, type: "expense", category: "food", date: d(6) },
  { merchant: "Blinkit", amount: 680, type: "expense", category: "food", date: d(8) },
  // Transport
  { merchant: "Uber", amount: 230, type: "expense", category: "transport", date: d(2) },
  { merchant: "Ola", amount: 180, type: "expense", category: "transport", date: d(5) },
  { merchant: "IRCTC - Train Ticket", amount: 1200, type: "expense", category: "transport", date: d(14) },
  // Shopping
  { merchant: "Amazon India", amount: 3499, type: "expense", category: "shopping", date: d(7) },
  { merchant: "Flipkart", amount: 1899, type: "expense", category: "shopping", date: d(9) },
  { merchant: "Myntra", amount: 2750, type: "expense", category: "clothing", date: d(12) },
  // Bills
  { merchant: "Airtel Mobile Recharge", amount: 599, type: "expense", category: "phone", date: d(15) },
  { merchant: "Tata Power - Electricity", amount: 1850, type: "expense", category: "bills", date: d(18) },
  { merchant: "Netflix", amount: 649, type: "expense", category: "ott", date: d(20) },
  { merchant: "Spotify Premium", amount: 119, type: "expense", category: "ott", date: d(20) },
  // Health
  { merchant: "Apollo Pharmacy", amount: 780, type: "expense", category: "health", date: d(11) },
  // Investment
  { merchant: "Zerodha - SIP", amount: 5000, type: "expense", category: "investment", date: d(3) },
  { merchant: "Groww - Mutual Fund", amount: 3000, type: "expense", category: "investment", date: d(3) },
  // Rent
  { merchant: "Rent - Flat Owner", amount: 22000, type: "expense", category: "rent", date: d(1) },
  // Older months
  { merchant: "Swiggy", amount: 520, type: "expense", category: "food", date: d(35) },
  { merchant: "Salary - Company", amount: 85000, type: "income", category: "income", date: d(32) },
  { merchant: "Amazon India", amount: 5299, type: "expense", category: "shopping", date: d(40) },
  { merchant: "Uber", amount: 310, type: "expense", category: "transport", date: d(38) },
  { merchant: "Zomato", amount: 410, type: "expense", category: "food", date: d(42) },
  { merchant: "Rent - Flat Owner", amount: 22000, type: "expense", category: "rent", date: d(31) },
  { merchant: "Salary - Company", amount: 85000, type: "income", category: "income", date: d(62) },
  { merchant: "Swiggy", amount: 380, type: "expense", category: "food", date: d(65) },
  { merchant: "Rent - Flat Owner", amount: 22000, type: "expense", category: "rent", date: d(61) },
  { merchant: "Netflix", amount: 649, type: "expense", category: "ott", date: d(50) },
  { merchant: "IRCTC - Train Ticket", amount: 2400, type: "expense", category: "transport", date: d(55) },
];

async function main() {
  console.log(`Seeding ${transactions.length} transactions for user ${USER_ID}...`);
  let inserted = 0;
  let skipped = 0;

  for (const tx of transactions) {
    const fingerprint = `seed-${tx.merchant}-${tx.date.toISOString().split("T")[0]}-${tx.amount}`;
    try {
      await prisma.transaction.upsert({
        where: { userId_fingerprint: { userId: USER_ID, fingerprint } },
        update: {},
        create: {
          userId: USER_ID,
          fingerprint,
          date: tx.date,
          merchant: tx.merchant,
          amount: tx.amount,
          type: tx.type,
          currency: "INR",
          category: tx.category,
          source: "seed",
          sourceRank: tx.sourceRank ?? 3,
          reviewed: true,
          needsReview: false,
        },
      });
      inserted++;
    } catch (e) {
      console.error(`Failed to insert ${tx.merchant}:`, e);
      skipped++;
    }
  }

  console.log(`Done. ${inserted} inserted, ${skipped} skipped.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
