import { test, expect } from "@playwright/test";

test("T10.1 assets page loads", async ({ page }) => {
  await page.goto("/assets");
  await expect(page.getByText(/asset|net worth|portfolio/i).first()).toBeVisible({ timeout: 10_000 });
});

test("T10.2 assets page shows balance or empty state", async ({ page }) => {
  await page.goto("/assets");
  const body = await page.locator("body").textContent();
  expect(body).toMatch(/₹|no assets|add.*asset|net worth/i);
});

test("T10.5 assets page does not crash on reload", async ({ page }) => {
  await page.goto("/assets");
  await page.reload();
  await expect(page.locator("body")).not.toContainText(/error|500|crash/i);
});
