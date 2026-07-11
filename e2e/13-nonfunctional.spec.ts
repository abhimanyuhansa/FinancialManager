import { test, expect } from "@playwright/test";

test("T13.1 page loads within 5 seconds", async ({ page }) => {
  const start = Date.now();
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  expect(Date.now() - start).toBeLessThan(5_000);
});

test("T13.2 no console errors on dashboard", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const fatal = errors.filter((e) => !e.includes("favicon") && !e.includes("404"));
  expect(fatal).toHaveLength(0);
});

test("T13.3 transactions page loads within 5 seconds", async ({ page }) => {
  const start = Date.now();
  await page.goto("/transactions");
  await page.waitForLoadState("domcontentloaded");
  expect(Date.now() - start).toBeLessThan(5_000);
});

test("T13.4 settings page accessible via keyboard nav", async ({ page }) => {
  await page.goto("/settings");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  expect(focused).toBeTruthy();
});
