import postgres from "postgres";
const sql = postgres("REDACTED_DATABASE_URL", { ssl: "require" });
async function main() {
  await sql`
    UPDATE "LlmCircuitBreaker"
    SET state = 'CLOSED', "consecutiveFailures" = 0, "openedAt" = NULL,
        "lastFailureAt" = NULL, "probeLeaseExpiresAt" = NULL
    WHERE provider IN ('gemini', 'openai')
  `;
  const cb = await sql`SELECT provider, state, "consecutiveFailures", "openedAt", "probeLeaseExpiresAt" FROM "LlmCircuitBreaker"`;
  cb.forEach((r) => console.log(JSON.stringify(r)));
  console.log("Both CBs reset to CLOSED.");
}
main().catch(e => { console.error(e.message); process.exit(1); }).finally(() => sql.end());
