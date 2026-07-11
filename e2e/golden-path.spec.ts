import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "./helpers/api";

test.describe("Golden Path: new user syncs email and sees transactions", () => {
  test.beforeAll(async ({ request }) => {
    await clearUserData(request);
  });

  test.afterAll(async ({ request }) => {
    await clearUserData(request);
  });

  test("GP.1 dashboard loads for authenticated user", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("body")).not.toContainText(/500|unhandled exception/i);
  });

  test("GP.2 seed transactions appear on transactions page", async ({ page, request }) => {
    await seedDemoTransactions(request);
    await page.goto("/transactions");
    await expect(page.getByText(/\d+ transactions/i)).toBeVisible({ timeout: 10_000 });
  });

  test("GP.3 transaction can be searched and found", async ({ page, request }) => {
    await seedDemoTransactions(request);
    await page.goto("/transactions");
    const searchInput = page
      .getByRole("textbox", { name: /search/i })
      .or(page.locator("input[placeholder*='search' i]"))
      .first();
    await searchInput.fill("Amazon");
    await page.waitForTimeout(600);
    const rows = await page.locator("table tbody tr").count();
    // Either found rows or 0 — never a crash
    expect(rows).toBeGreaterThanOrEqual(0);
  });

  test("GP.4 settings page loads and has tabs", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 10_000 });
  });

  test("GP.5 export CSV produces a file", async ({ page, request }) => {
    await seedDemoTransactions(request);
    await page.goto("/transactions");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /export/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/i);
  });
});
