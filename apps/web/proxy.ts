import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "true";

const isSignInPage = createRouteMatcher(["/sign-in"]);
const isProtectedRoute = createRouteMatcher(["/w(.*)"]);

// Built lazily so mock mode never needs NEXT_PUBLIC_CONVEX_URL.
let authProxy: ReturnType<typeof convexAuthNextjsMiddleware> | null = null;
function getAuthProxy() {
  authProxy ??= convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
    const signedIn = await convexAuth.isAuthenticated();
    if (isSignInPage(request) && signedIn) {
      return nextjsMiddlewareRedirect(request, "/");
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
  return getAuthProxy()(request, event);
}

export const config = {
  // Everything except static files and Next internals; /api/auth must pass through.
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
