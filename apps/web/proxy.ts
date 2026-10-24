import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { safeNext } from "./lib/safeNext";

const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "true";

const isSignInPage = createRouteMatcher(["/sign-in"]);
const isProtectedRoute = createRouteMatcher(["/w(.*)"]);

// Built lazily so mock mode never needs NEXT_PUBLIC_CONVEX_URL.
let authProxy: ReturnType<typeof convexAuthNextjsMiddleware> | null = null;
function getAuthProxy() {
  authProxy ??= convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
    const signedIn = await convexAuth.isAuthenticated();
    // GET only: right after sign-in/sign-up, Convex Auth's cache-invalidation
    // server action POSTs to /sign-in; redirecting that POST makes the client
    // land on the wrong page. The page itself then replaces to ?next=.
    if (isSignInPage(request) && signedIn && request.method === "GET") {
      // Honor ?next= (e.g. an invite link or a deep link).
      const next = safeNext(request.nextUrl.searchParams.get("next"), request.nextUrl.origin);
      return nextjsMiddlewareRedirect(request, next);
    }
    if (isProtectedRoute(request) && !signedIn) {
      const next = encodeURIComponent(request.nextUrl.pathname);
      return nextjsMiddlewareRedirect(request, `/sign-in?next=${next}`);
    }
  });
  return authProxy;
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // Mock mode has no server-side session; the client-side guard handles it.
  if (USE_MOCKS) return NextResponse.next();
  // Health checks must not depend on Convex being reachable.
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();
  return getAuthProxy()(request, event);
}

export const config = {
  // Everything except Next's static output and asset files; /api/auth must pass
  // through. Match asset extensions only, so ids with dots (/w/acme.prod) are guarded.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|css|js|map|txt)$).*)",
  ],
};
