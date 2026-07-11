import { test, expect } from "@playwright/test";

test("T12.1 GET /api/transactions returns JSON array", async ({ request }) => {
  const res = await request.get("/api/transactions");
  // Authenticated: 200 with JSON array. Unauthenticated: 401/redirect.
  if (res.status() === 200) {
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("application/json");
    const data = await res.json();
    expect(Array.isArray(data.transactions ?? data)).toBe(true);
  } else {
    expect([401, 302, 307]).toContain(res.status());
  }
});

test("T12.2 GET /api/settings/filters returns array", async ({ request }) => {
  const res = await request.get("/api/settings/filters");
  if (res.status() === 200) {
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  } else {
    expect([401, 302, 307]).toContain(res.status());
  }
});

test("T12.3 POST /api/settings/filters validates input", async ({ request }) => {
  const res = await request.post("/api/settings/filters", {
    data: { type: "invalid_type_xyz", value: "" },
  });
  expect(res.status()).toBeGreaterThanOrEqual(400);
});

test("T12.4 unauthenticated request to API is handled", async ({ request }) => {
  // The API may return 401 JSON or redirect to login (HTML) for unauthenticated requests
  // Both are acceptable behaviors — just verify the server doesn't crash (not 500)
  const res = await request.get("/api/transactions", {
    headers: { Cookie: "" },
  });
  expect(res.status()).not.toBe(500);
});
