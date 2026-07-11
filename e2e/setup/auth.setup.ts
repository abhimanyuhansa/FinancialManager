import { test as setup } from "@playwright/test";
import path from "path";
import fs from "fs";

const AUTH_FILE = path.join(__dirname, "../.auth/user.json");

setup("authenticate via session seed", async ({ request }) => {
  // Check if valid auth state already exists (< 50 min old)
  if (fs.existsSync(AUTH_FILE)) {
    const age = Date.now() - fs.statSync(AUTH_FILE).mtimeMs;
    if (age < 50 * 60 * 1000) {
      console.log("[setup] Reusing cached auth session");
      return;
    }
  }

  // Call our test-auth endpoint to get a seeded session cookie
  const res = await request.post("/api/test/auth-seed", {
    data: { secret: process.env.CRON_SECRET },
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok()) {
    throw new Error(`Auth seed failed: ${res.status()} — ensure /api/test/auth-seed exists`);
  }

  const cookies = await res.json();
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ cookies, origins: [] }, null, 2)
  );

  console.log("[setup] Auth session seeded and saved");
});
