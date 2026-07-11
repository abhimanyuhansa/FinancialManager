import { test, expect } from "@playwright/test";

test("T8.1 statement passwords tab loads", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: /password/i }).click();
  await expect(
    page.getByText(/pending|saved|statement password/i).first()
  ).toBeVisible({ timeout: 10_000 });
});

test("T8.3 saved password not shown in plaintext", async ({ request }) => {
  await request.post("/api/settings/statement-passwords", {
    data: { senderDomain: "e2e-bank-test.com", password: "secret123" },
  });

  const res = await request.get("/api/settings/statement-passwords");
  const data = await res.json();
  const entry = data.stored?.find((s: { senderDomain: string }) => s.senderDomain === "e2e-bank-test.com");

  if (entry) {
    expect(JSON.stringify(entry)).not.toContain("secret123");
  }

  await request.delete("/api/settings/statement-passwords/e2e-bank-test.com");
});
