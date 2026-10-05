import { type NextRequest, NextResponse } from "next/server";

const SESSION_COOKIES = [
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
  if (pathname === "/healthz" || pathname === "/icon.svg") return NextResponse.next();
  if (process.env.NODE_ENV !== "production" && process.env.USEAGENT_PREVIEW_OPEN === "1") {
    return NextResponse.next();
  }
  return null;
}

function isPublicPage(pathname: string): boolean {
  return (
    pathname === "/desktop-auth" ||
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/signup" ||
    pathname.startsWith("/signup/")
  );
}

export function proxy(request: NextRequest): NextResponse {
  const response = routeResponse(request);
  if (response) return response;
  if (isPublicPage(request.nextUrl.pathname)) return NextResponse.next();
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  return hasSession ? NextResponse.next() : NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: [
    "/((?!api|healthz|download$|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
