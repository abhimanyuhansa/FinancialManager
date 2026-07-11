import { test, expect } from "@playwright/test";

test("T9.1 parse logs tab loads", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /log/i }).click();
  await expect(page.getByText(/parse log|email log|outcome/i).first()).toBeVisible({ timeout: 10_000 });
});
