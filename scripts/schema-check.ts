import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require" });

async function main() {
  // SyncJob columns
  const jobCols = await sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'SyncJob' ORDER BY ordinal_position
  `;
  console.log("SyncJob cols:", jobCols.map((c) => c.column_name).join(", "));

  // Recent sync jobs
  const jobs = await sql`SELECT * FROM "SyncJob" ORDER BY "startedAt" DESC LIMIT 3`;
  console.log("Recent jobs:");
  jobs.forEach((j) => console.log(JSON.stringify(j)));

  // LLM call timeline for latest problematic job
  const calls = await sql`
    SELECT "createdAt", provider, outcome, "latencyMs", "inputTokens", "batchKey"
    FROM "LlmCallLog"
    WHERE "syncJobId" = 'cmrkdx3pc000004jopqmveqr6'
    ORDER BY "createdAt" ASC
    LIMIT 30
  `;
  console.log("\nLLM call timeline for job cmrkdx3pc:");
  calls.forEach((c) => console.log(JSON.stringify(c)));

  // Count successful calls in that job
  const [successes] = await sql`
    SELECT COUNT(*) as cnt FROM "LlmCallLog"
    WHERE "syncJobId" = 'cmrkdx3pc000004jopqmveqr6' AND outcome = 'success'
  `;
  const [errorsCount] = await sql`
    SELECT COUNT(*) as cnt FROM "LlmCallLog"
    WHERE "syncJobId" = 'cmrkdx3pc000004jopqmveqr6' AND outcome = 'error'
  `;
  console.log(`\nJob cmrkdx3pc: successes=${successes.cnt}, errors=${errorsCount.cnt}`);

  await sql.end();
}

main().catch(console.error);
