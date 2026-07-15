import postgres from "postgres";

const DB_URL =
  "REDACTED_DATABASE_URL";

const sql = postgres(DB_URL, { ssl: "require" });

async function main() {
  const [cb, logs, job] = await Promise.all([
    sql`SELECT provider, state, "consecutiveFailures", "openedAt", "probeLeaseExpiresAt" FROM "LlmCircuitBreaker"`,
    sql`SELECT provider, model, outcome, "latencyMs", "inputTokens", "outputTokens", "finishReason", "effectiveTimeoutMs", "errorDetail", "createdAt"
        FROM "LlmCallLog" ORDER BY "createdAt" DESC LIMIT 8`,
    sql`SELECT id, status, "processedEmails", "totalEmails", "newTransactions" FROM "SyncJob" ORDER BY "startedAt" DESC LIMIT 1`,
  ]);

  console.log("=== Circuit Breakers ===");
  cb.forEach((r) => console.log(JSON.stringify(r)));
  console.log("\n=== Last 8 LLM Calls ===");
  logs.forEach((r) => console.log(JSON.stringify(r)));
  console.log("\n=== Latest Job ===");
  job.forEach((r) => console.log(JSON.stringify(r)));
}

main()
  .catch((e) => { console.error(e.message); process.exit(1); })
  .finally(() => sql.end());
