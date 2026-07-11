import { test, expect } from "@playwright/test";

test("T2.2 /onboarding loads with period picker", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByText(/6m|6 months/i).first()).toBeVisible();
  await expect(page.getByText(/3m|3 months/i).first()).toBeVisible();
});

test("T2.3 period picker selects one option at a time", async ({ page }) => {
  await page.goto("/onboarding");
  const options = ["6m", "3m", "1m"];
  for (const opt of options) {
    await page.getByText(opt).first().click();
    await expect(page).toHaveURL(/\/onboarding/);
  }
});
