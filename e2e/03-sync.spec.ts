import { test, expect } from "@playwright/test";
import { triggerCronAdvance } from "./helpers/api";

test("T3.1 sync button visible when no active job", async ({ page }) => {
  await page.goto("/dashboard");
  const syncBtn = page.getByRole("button", { name: /sync gmail/i });
  const overlay = page.getByText(/get started|start sync/i);
  await expect(syncBtn.or(overlay).first()).toBeVisible({ timeout: 10_000 });
});

test("T3.2 starting sync returns jobId fast", async ({ request }) => {
  const start = Date.now();
  const res = await request.post("/api/gmail/sync/start");
  const elapsed = Date.now() - start;

  expect([200, 201, 401, 409]).toContain(res.status());
  expect(elapsed).toBeLessThan(3000);

  if (res.status() === 200 || res.status() === 201) {
    const body = await res.json();
    expect(body).toHaveProperty("jobId");
    expect(typeof body.jobId).toBe("string");
  }
});

test("T3.3 starting sync while one is running returns 409", async ({ request }) => {
  const r1 = await request.post("/api/gmail/sync/start");
  if (r1.status() === 401) {
    test.skip(); // test user has no Gmail token
    return;
  }
  if (r1.status() === 409) return; // already running

  const r2 = await request.post("/api/gmail/sync/start");
  expect(r2.status()).toBe(409);
  const body = await r2.json();
  expect(body.running).toBe(true);
  expect(body).toHaveProperty("jobId");
});

test("T3.4 cron advance endpoint rejects without auth", async ({ request }) => {
  // Should reject unauthenticated cron calls — expect 401 or 403
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Cookie: "" },  // strip session cookies to simulate unauthenticated
  });
  expect([401, 403]).toContain(res.status());
});

test("T3.5 cron advance endpoint 200 with correct bearer token", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  expect(res.status()).toBe(200);
});

test("T3.6 cron advance with wrong secret is rejected", async ({ request }) => {
  const res = await request.get("/api/gmail/sync/advance", {
    headers: { Authorization: "Bearer wrong-secret-value", Cookie: "" },
  });
  expect([401, 403]).toContain(res.status());
});
