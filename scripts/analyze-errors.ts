import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require" });

async function main() {
  // 1. All stuck emails with sender info
  const stuck = await sql`
    SELECT pl.id, pl."createdAt", pl."senderDomain", pl."errorDetail", pl."syncJobId",
           sjm.id AS "msgId", sjm.processed, sjm."gmailMsgId"
    FROM "ParseLog" pl
    JOIN "SyncJobMessage" sjm ON sjm."gmailMsgId" = pl."gmailMsgId" AND sjm."syncJobId" = pl."syncJobId"
    WHERE pl.outcome = 'error'
    ORDER BY pl."createdAt" DESC
    LIMIT 30
  `;
  console.log("=== STUCK EMAILS (ParseLog outcome=error) ===");
  stuck.forEach((s) => console.log(JSON.stringify(s)));

  // 2. Summary counts
  const [stuckTotal] = await sql`SELECT COUNT(*) as cnt FROM "ParseLog" WHERE outcome = 'error'`;
  console.log(`\nTotal ParseLog errors: ${stuckTotal.cnt}`);

  // Count SyncJobMessages that are permanently skipped
  const [stuckMsgs] = await sql`
    SELECT COUNT(DISTINCT sjm.id) as cnt
    FROM "SyncJobMessage" sjm
    JOIN "ParseLog" pl ON pl."gmailMsgId" = sjm."gmailMsgId" AND pl."syncJobId" = sjm."syncJobId"
    WHERE pl.outcome = 'error' AND sjm.processed = true
  `;
  console.log(`SyncJobMessages permanently stuck (processed=true, parseLog=error): ${stuckMsgs.cnt}`);

  // 3. What domains are stuck?
  const domains = await sql`
    SELECT "senderDomain", COUNT(*) as cnt
    FROM "ParseLog"
    WHERE outcome = 'error'
    GROUP BY "senderDomain"
    ORDER BY cnt DESC
  `;
  console.log("\n=== STUCK DOMAINS ===");
  domains.forEach((d) => console.log(JSON.stringify(d)));

  // 4. What error types for the stuck emails?
  const errorTypes = await sql`
    SELECT "errorDetail", COUNT(*) as cnt
    FROM "ParseLog"
    WHERE outcome = 'error'
    GROUP BY "errorDetail"
    ORDER BY cnt DESC
  `;
  console.log("\n=== ERROR TYPES IN ParseLog ===");
  errorTypes.forEach((e) => console.log(JSON.stringify(e)));

  // 5. What's the current job status?
  const jobs = await sql`
    SELECT id, status, "totalMessages", "processedMessages", "errorMessages", "createdAt", "updatedAt"
    FROM "SyncJob"
    ORDER BY "createdAt" DESC
    LIMIT 5
  `;
  console.log("\n=== RECENT SYNC JOBS ===");
  jobs.forEach((j) => console.log(JSON.stringify(j)));

  // 6. For the most recent large job, how many remain unprocessed?
  const latestJob = jobs[0];
  if (latestJob) {
    const [unprocessed] = await sql`
      SELECT COUNT(*) as cnt FROM "SyncJobMessage"
      WHERE "syncJobId" = ${latestJob.id} AND processed = false
    `;
    console.log(`\nLatest job (${latestJob.id}): ${unprocessed.cnt} unprocessed / ${latestJob.totalMessages} total`);
  }

  await sql.end();
}

main().catch(console.error);
