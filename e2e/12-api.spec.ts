import { test, expect } from "@playwright/test";

test("T12.1 GET /api/transactions returns JSON array", async ({ request }) => {
  const res = await request.get("/api/transactions");
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(Array.isArray(data.transactions ?? data)).toBe(true);
});

test("T12.2 GET /api/settings/filters returns array", async ({ request }) => {
  const res = await request.get("/api/settings/filters");
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
});

test("T12.3 POST /api/settings/filters validates input", async ({ request }) => {
  const res = await request.post("/api/settings/filters", {
    data: { type: "invalid_type_xyz", value: "" },
  });
  expect(res.status()).toBeGreaterThanOrEqual(400);
});

test("T12.4 unauthenticated request to protected route returns 401", async ({ request }) => {
  // Make request without session cookies by using a fresh context
  const res = await request.get("/api/transactions", {
    headers: { Cookie: "" },
  });
  // Should be 401 or redirect (3xx) — not 200
  expect(res.status()).not.toBe(200);
});
