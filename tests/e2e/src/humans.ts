// A human as the dashboard sees them: a Convex Auth Password session driving
// the dashboard's own data layer (apps/web/lib/api/convex.ts) over a
// ConvexReactClient, exactly as ConvexProviders wires it in the browser.
import { api } from "@repo/backend/convex/_generated/api.js";
import { ConvexHttpClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { createConvexApi } from "../../../apps/web/lib/api/convex";
import type { TandemApi } from "../../../apps/web/lib/api/tandemApi";

export interface Human {
  email: string;
  password: string;
  name: string;
  /** The Convex Auth JWT. */
  jwt: string;
  /** Direct Convex calls with this session (for functions TandemApi doesn't wrap). */
  http: ConvexHttpClient;
  /** The dashboard's TandemApi on this session. */
  dashboard: TandemApi;
  close(): Promise<void>;
}

/** Same `auth:signIn` action the dashboard's sign-in form calls (useAuthActions). */
export async function passwordSignIn(
  convexUrl: string,
  params: { email: string; password: string; flow: "signUp" | "signIn"; name?: string },
): Promise<string> {
  const client = new ConvexHttpClient(convexUrl, { logger: false });
  let result;
  try {
    result = await client.action(api.auth.signIn, { provider: "password", params });
  } catch (err) {
    // A fresh deployment has no Convex Auth keys yet (docs/local-dev.md step 2).
    if (/JWT_PRIVATE_KEY|JWKS|SITE_URL/.test(String(err)))
      throw new Error(
        "Convex Auth isn't configured on this deployment: run `node scripts/setup-auth-env.mjs` in packages/backend once.",
        { cause: err },
      );
    throw err;
  }
  const jwt = result.tokens?.token;
  if (!jwt) throw new Error(`auth:signIn (${params.flow}) returned no token for ${params.email}`);
  return jwt;
}

export async function signUp(
  convexUrl: string,
  person: { email: string; password: string; name: string },
): Promise<Human> {
  const jwt = await passwordSignIn(convexUrl, { ...person, flow: "signUp" });
  return session(convexUrl, person, jwt);
}

/** An existing Password user, such as a seeded demo member. */
export async function signIn(
  convexUrl: string,
  person: { email: string; password: string; name: string },
): Promise<Human> {
  const jwt = await passwordSignIn(convexUrl, {
    email: person.email,
    password: person.password,
    flow: "signIn",
  });
  return session(convexUrl, person, jwt);
}

function session(
  convexUrl: string,
  person: { email: string; password: string; name: string },
  jwt: string,
): Human {
  const http = new ConvexHttpClient(convexUrl, { logger: false });
  http.setAuth(jwt);
  const react = new ConvexReactClient(convexUrl, {
    unsavedChangesWarning: false,
    logger: false,
  });
  react.setAuth(async () => jwt);
  return {
    ...person,
    jwt,
    http,
    dashboard: createConvexApi(react),
    close: () => react.close(),
  };
}
