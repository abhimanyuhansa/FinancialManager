import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "./helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T4.1 dashboard renders all key sections", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.locator("[data-testid='kpi-card'], .kpi-card, [class*='KpiCard']").first())
    .toBeVisible({ timeout: 10_000 });
});

test("T4.2 KPI cards show currency values", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByText(/₹/)).toBeVisible({ timeout: 10_000 });
});

test("T4.3 recent transactions section has rows", async ({ page }) => {
  await page.goto("/dashboard");
  const rows = page.locator("table tbody tr, [role='row']");
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
});

test("T4.6 clicking transaction row opens detail panel", async ({ page }) => {
  await page.goto("/dashboard");
  const firstRow = page.locator("table tbody tr, [role='row']").first();
  await firstRow.click();
  await expect(
    page.getByRole("dialog").or(page.locator("[data-testid='transaction-panel']")).first()
  ).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog").or(page.locator("[data-testid='transaction-panel']")).first()
  ).not.toBeVisible({ timeout: 3_000 });
});

test("T4.10 nav links navigate to correct pages", async ({ page }) => {
  await page.goto("/dashboard");
  const navLinks: Array<[RegExp, RegExp]> = [
    [/transactions/i, /\/transactions/],
    [/analytics/i, /\/analytics/],
    [/assets/i, /\/assets/],
    [/settings/i, /\/settings/],
  ];
  for (const [linkText, expectedUrl] of navLinks) {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: linkText }).first().click();
    await expect(page).toHaveURL(expectedUrl, { timeout: 5_000 });
  }
});
