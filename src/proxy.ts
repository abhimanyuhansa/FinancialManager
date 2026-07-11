import { NextRequest, NextResponse } from "next/server";

const publicPaths = [
  "/login",
  "/api/auth",
  "/api/gmail/sync/advance",  // uses bearer token auth, not session
  "/api/test/auth-seed",      // uses CRON_SECRET, not session
  "/api/health",              // health check
];

// Database sessions use an opaque token — just check cookie presence.
// Importing auth() here would try to JWT-decrypt a DB session token and fail.
function isAuthenticated(req: NextRequest): boolean {
  const cookieName =
    process.env.NODE_ENV === "production"
      ? "__Secure-authjs.session-token"
      : "authjs.session-token";
  return !!req.cookies.get(cookieName)?.value;
}

export default function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));

  if (!isPublic && !isAuthenticated(req)) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
