import { test, expect } from "@playwright/test";

test("T7.1 settings page has 4 tabs", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("tab", { name: /filter/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("tab", { name: /audit|reconcil/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /password/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /log/i })).toBeVisible();
});

test("T7.2 add a sender_domain filter", async ({ page, request }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /filter/i }).click();

  const typeSelect = page.getByRole("combobox").or(page.locator("select")).first();
  if (await typeSelect.isVisible()) {
    await typeSelect.selectOption("sender_domain");
  }
  await page.getByRole("textbox").fill("e2etest-hdfcbank.com");
  await page.getByRole("button", { name: /add filter/i }).click();

  await expect(page.getByText("e2etest-hdfcbank.com")).toBeVisible({ timeout: 5_000 });

  // Clean up
  const filtersRes = await request.get("/api/settings/filters");
  const filters = await filtersRes.json();
  const filter = filters.find((f: { value: string; id: string }) => f.value === "e2etest-hdfcbank.com");
  if (filter) {
    await request.delete(`/api/settings/filters/${filter.id}`);
  }
});

test("T7.5 delete a filter removes it", async ({ page, request }) => {
  const res = await request.post("/api/settings/filters", {
    data: { type: "sender_domain", value: "e2e-delete-test.com", sourceRank: 1 },
  });
  const { id } = await res.json();

  await page.goto("/settings");
  await page.getByRole("tab", { name: /filter/i }).click();
  await expect(page.getByText("e2e-delete-test.com")).toBeVisible();

  await page.getByRole("button", { name: /delete/i }).first().click();
  const confirmBtn = page.getByRole("button", { name: /confirm|yes|delete/i });
  if (await confirmBtn.isVisible({ timeout: 1_000 })) {
    await confirmBtn.click();
  }

  await expect(page.getByText("e2e-delete-test.com")).not.toBeVisible({ timeout: 5_000 });
});
