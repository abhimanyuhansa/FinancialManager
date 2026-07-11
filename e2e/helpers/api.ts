import type { APIRequestContext } from "@playwright/test";

export async function clearUserData(request: APIRequestContext) {
  const res = await request.delete("/api/user/data", {
    data: { confirm: true },
  });
  // 200 or 404 (if nothing to delete) are both acceptable
  if (res.status() !== 200 && res.status() !== 404) {
    console.warn(`[helpers] clearUserData returned ${res.status()}`);
  }
}

export async function seedDemoTransactions(request: APIRequestContext) {
  const res = await request.post("/api/transactions/demo");
  if (!res.ok()) throw new Error(`Demo seed failed: ${res.status()}`);
  return res.json();
}

export async function waitForSyncComplete(
  request: APIRequestContext,
  jobId: string,
  timeoutMs = 600_000
): Promise<{ status: string; newTransactions: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 15_000));
    const res = await request.get(`/api/gmail/sync/status?jobId=${jobId}`);
    if (!res.ok()) continue;
    const data = await res.json();
    if (data.done) return data;
    console.log(`[wait] sync ${jobId}: ${data.status} ${data.processedEmails}/${data.totalEmails}`);
  }
  throw new Error(`Sync job ${jobId} did not complete within ${timeoutMs}ms`);
}

export async function triggerCronAdvance(request: APIRequestContext) {
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  if (!res.ok()) throw new Error(`Cron advance failed: ${res.status()}`);
  return res.json();
}
