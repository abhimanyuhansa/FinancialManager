/**
 * One-time script: reset processed=false for SyncJobMessage rows where
 * the corresponding ParseLog has outcome='error'. These emails were
 * permanently skipped due to LLM timeouts/exhaustion and will be
 * picked up by the next sync advance() call.
 *
 * Usage: npx tsx scripts/reset-error-emails.ts [--dry-run]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require" });

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Find all SyncJobMessage IDs where ParseLog.outcome='error'
  const stuck = await sql`
    SELECT DISTINCT sjm.id, sjm."syncJobId", sjm."gmailMsgId", sjm.processed,
                    pl."senderDomain", pl."errorDetail"
    FROM "SyncJobMessage" sjm
    JOIN "ParseLog" pl ON pl."gmailMsgId" = sjm."gmailMsgId" AND pl."syncJobId" = sjm."syncJobId"
    WHERE pl.outcome = 'error' AND sjm.processed = true
    ORDER BY pl."senderDomain", sjm.id
  `;

  console.log(`Found ${stuck.length} stuck SyncJobMessage rows`);

  // Group by domain for visibility
  const byDomain = new Map<string, number>();
  for (const row of stuck) {
    const d = row.senderDomain ?? "unknown";
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  }
  console.log("\nBy domain:");
  for (const [domain, cnt] of [...byDomain.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${domain}: ${cnt}`);
  }

  if (dryRun) {
    console.log("\n[DRY RUN] Would reset processed=false for all above rows. Re-run without --dry-run to apply.");
    await sql.end();
    return;
  }

  const ids = stuck.map((r) => r.id);
  if (ids.length === 0) {
    console.log("\nNothing to reset.");
    await sql.end();
    return;
  }

  const updated = await sql`
    UPDATE "SyncJobMessage"
    SET processed = false
    WHERE id = ANY(${sql.array(ids)})
    RETURNING id
  `;

  console.log(`\nReset ${updated.length} rows to processed=false`);
  console.log("These emails will be picked up on the next sync advance() call.");

  await sql.end();
}

main().catch(console.error);
