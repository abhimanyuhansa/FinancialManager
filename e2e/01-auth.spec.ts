import { test, expect } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } }); // unauthenticated for this suite

test("T1.1 unauthenticated user redirected to /login", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("T1.2 unauthenticated /transactions redirects to /login", async ({ page }) => {
  await page.goto("/transactions");
  await expect(page).toHaveURL(/\/login/);
});

test("T1.3 login page has Google button", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
});
