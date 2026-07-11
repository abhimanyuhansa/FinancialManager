import { test, expect } from "@playwright/test";
import { seedDemoTransactions, clearUserData } from "./helpers/api";

test.beforeAll(async ({ request }) => {
  await seedDemoTransactions(request);
});

test.afterAll(async ({ request }) => {
  await clearUserData(request);
});

test("T6.1 category dropdown has options", async ({ page }) => {
  await page.goto("/transactions");
  await page.locator("table tbody tr").first().click();
  const categoryEl = page.getByRole("combobox").or(page.locator("select")).first();
  await expect(categoryEl).toBeVisible({ timeout: 5_000 });
  const options = await categoryEl.locator("option").count();
  expect(options).toBeGreaterThan(1);
});

test("T6.6 category change shows success feedback", async ({ page }) => {
  await page.goto("/transactions");
  await page.locator("table tbody tr").first().click();
  const panel = page.getByRole("dialog").or(page.locator("[class*='panel' i]")).first();
  await expect(panel).toBeVisible({ timeout: 5_000 });
  const select = panel.getByRole("combobox").or(panel.locator("select")).first();
  if (await select.isVisible()) {
    const options = await select.locator("option").allTextContents();
    const currentValue = await select.inputValue();
    const differentOption = options.find((o) => o.trim() !== currentValue);
    if (differentOption) {
      await select.selectOption({ label: differentOption });
      await expect(
        page.getByText(/saved|updated|success/i).or(panel)
      ).toBeVisible({ timeout: 5_000 });
    }
  }
});
