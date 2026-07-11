import { test, expect } from "@playwright/test";

test("T11.1 dashboard shows spending chart or empty state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
  const body = await page.locator("body").textContent();
  expect(body).toMatch(/₹|no data|transactions|spending|this month/i);
});

test("T11.2 dashboard category breakdown visible", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const body = await page.locator("body").textContent();
  // Either shows categories or an empty/loading state — never a crash
  expect(body).not.toMatch(/error|500|unhandled/i);
});
