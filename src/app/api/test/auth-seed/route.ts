import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Guard: this endpoint must never be accessible in production
// It is only enabled when CRON_SECRET matches, providing a safety gate
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && !process.env.ENABLE_TEST_AUTH_SEED) {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const body = await req.json();
  if (body.secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find or create the test user
  const testEmail = process.env.TEST_USER_EMAIL ?? "test@financialmanager.dev";
  let user = await prisma.user.findUnique({ where: { email: testEmail } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: testEmail,
        name: "Test User",
        emailVerified: new Date(),
      },
    });
  }

  // Create a session that expires in 24 hours
  const sessionToken = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.session.upsert({
    where: { sessionToken },
    create: { sessionToken, userId: user.id, expires },
    update: { expires },
  });

  // Return the cookie Playwright should inject
  const cookies = [
    {
      name: "authjs.session-token",
      value: sessionToken,
      domain: new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000").hostname,
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax" as const,
      expires: Math.floor(expires.getTime() / 1000),
    },
  ];

  return NextResponse.json(cookies);
}
