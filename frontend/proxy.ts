import { type ClerkMiddlewareAuth, clerkMiddleware } from "@clerk/nextjs/server";
import {
  type NextFetchEvent,
  type NextMiddleware,
  type NextRequest,
  NextResponse,
} from "next/server";

import { legacyAuthEnabled } from "@/lib/auth-mode";

const LEGACY_SESSION_COOKIES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

function routeResponse(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    const canonical = new URL(request.url);
    canonical.pathname = pathname.replace(/\/+$/, "");
    return NextResponse.redirect(canonical, 308);
  }
  if (pathname === "/healthz") return NextResponse.next();
  if (process.env.NODE_ENV !== "production" && process.env.USEAGENT_PREVIEW_OPEN === "1") {
    return NextResponse.next();
  }
  return null;
}

function isPublicPage(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/signup" ||
    pathname.startsWith("/signup/")
  );
}

export function legacyProxy(request: NextRequest): NextResponse {
  const response = routeResponse(request);
  if (response) return response;
  if (isPublicPage(request.nextUrl.pathname)) return NextResponse.next();
  const hasSession = LEGACY_SESSION_COOKIES.some((name) => request.cookies.has(name));
  return hasSession ? NextResponse.next() : NextResponse.redirect(new URL("/login", request.url));
}

export async function identityProxy(
  auth: ClerkMiddlewareAuth,
  request: NextRequest,
): Promise<NextResponse> {
  const response = routeResponse(request);
  if (response) return response;
  if (isPublicPage(request.nextUrl.pathname)) return NextResponse.next();
  const { userId } = await auth();
  return userId ? NextResponse.next() : NextResponse.redirect(new URL("/login", request.url));
}

const providerMiddleware = clerkMiddleware(identityProxy);

export function identityMiddlewareProxy(
  request: NextRequest,
  event: NextFetchEvent,
  next: NextMiddleware = providerMiddleware,
): ReturnType<NextMiddleware> {
  return routeResponse(request) ?? next(request, event);
}

export const proxy: NextMiddleware = legacyAuthEnabled ? legacyProxy : identityMiddlewareProxy;

export const config = {
  matcher: ["/((?!api|healthz|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
