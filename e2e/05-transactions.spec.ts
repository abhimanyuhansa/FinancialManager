import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "./helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T5.1 transactions page loads with count", async ({ page }) => {
  await page.goto("/transactions");
  await expect(page.getByText(/\d+ transactions/i)).toBeVisible({ timeout: 10_000 });
});

test("T5.2 each row shows date, merchant, amount", async ({ page }) => {
  await page.goto("/transactions");
  const firstRow = page.locator("table tbody tr").first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/₹/).first()).toBeVisible();
});

test("T5.3 search filters transactions", async ({ page }) => {
  await page.goto("/transactions");
  const searchInput = page.getByRole("textbox", { name: /search/i })
    .or(page.locator("input[placeholder*='search' i]")).first();
  await searchInput.fill("ZZZNOMATCH_12345");
  await page.waitForTimeout(600);
  const bodyText = await page.locator("body").textContent();
  expect(bodyText).toMatch(/no transactions|0 transactions/i);
});

test("T5.12 export CSV triggers download", async ({ page }) => {
  await page.goto("/transactions");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /export/i }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/i);
});

test("T5.14 empty state when no transactions", async ({ page, request }) => {
  await clearUserData(request);
  await page.goto("/transactions");
  await expect(page.getByText(/no transactions|0 transactions/i)).toBeVisible({ timeout: 10_000 });
});
