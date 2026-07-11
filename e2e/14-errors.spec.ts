import { test, expect } from "@playwright/test";

test("T14.1 404 page renders gracefully", async ({ page }) => {
  await page.goto("/this-route-does-not-exist-xyz");
  const body = await page.locator("body").textContent();
  expect(body).toMatch(/404|not found|page.*not.*found/i);
});

test("T14.2 invalid transaction id returns error state", async ({ request }) => {
  const res = await request.get("/api/transactions/nonexistent-id-xyz");
  expect(res.status()).toBeGreaterThanOrEqual(400);
});

test("T14.3 malformed JSON body returns 400", async ({ request }) => {
  const res = await request.post("/api/settings/filters", {
    headers: { "Content-Type": "application/json" },
    data: "not-valid-json{{{",
  });
  expect(res.status()).toBeGreaterThanOrEqual(400);
});
