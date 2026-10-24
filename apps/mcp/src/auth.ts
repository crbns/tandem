import type { Actor, TandemBackend } from "./backend/types.js";

/**
 * Turns an API key into a verified identity. The dev resolver below will be
 * replaced by an OAuth/JWT verifier implementing the same interface.
 */
export interface IdentityResolver {
  /**
   * `key` is null when the request has no `api-key` header. Returns null when
   * the key is missing, unknown, expired, or invalid.
   */
  resolve(key: string | null): Promise<Actor | null>;
}

/** Resolves keys from a static map, e.g. TANDEM_DEV_TOKENS="key1:user_alex,key2:user_sam". */
export class DevTokenResolver implements IdentityResolver {
  private readonly tokens: Map<string, string>;

  constructor(spec: string) {
    this.tokens = new Map();
    for (const entry of spec.split(",")) {
      if (!entry.trim()) continue;
      // Split on the first ":" only, so user ids may contain ":".
      const sep = entry.indexOf(":");
      const token = sep === -1 ? "" : entry.slice(0, sep).trim();
      const userId = sep === -1 ? "" : entry.slice(sep + 1).trim();
      if (token && userId) {
        this.tokens.set(token, userId);
      } else {
        console.warn(
          `TANDEM_DEV_TOKENS: ignoring malformed entry ${JSON.stringify(entry.trim())}; expected key:user_id.`,
        );
      }
    }
  }

  get size(): number {
    return this.tokens.size;
  }

  async resolve(key: string | null): Promise<Actor | null> {
    const userId = key ? this.tokens.get(key) : undefined;
    return userId ? { user_id: userId, client: "dev-token" } : null;
  }
}

/**
 * TEMPORARY dev aid for clients that can't send a static API key (claude.ai
 * custom connectors before OAuth lands): requests with no `api-key` header act
 * as a fixed user. Requests that do carry a key still go through `inner`.
 */
export class DevAnonResolver implements IdentityResolver {
  constructor(
    private readonly inner: IdentityResolver,
    readonly userId: string,
  ) {}

  async resolve(key: string | null): Promise<Actor | null> {
    if (key === null) return { user_id: this.userId, client: "dev-anon" };
    return this.inner.resolve(key);
  }
}

const DEV_ANON_NODE_ENVS = new Set(["development", "test"]);

/**
 * Wraps `inner` in DevAnonResolver when TANDEM_DEV_ANON_USER is set. Fails closed:
 * refuses unless the backend actually constructed is the mock and NODE_ENV is
 * exactly "development" or "test".
 */
export function withDevAnon(
  inner: IdentityResolver,
  env: NodeJS.ProcessEnv,
  backend: Pick<TandemBackend, "kind">,
): IdentityResolver {
  const userId = env.TANDEM_DEV_ANON_USER?.trim();
  if (!userId) return inner;
  if (backend.kind !== "mock" || !DEV_ANON_NODE_ENVS.has(env.NODE_ENV ?? "")) {
    throw new Error(
      "TANDEM_DEV_ANON_USER is only allowed with the mock backend and NODE_ENV=development or test. Unset it.",
    );
  }
  return new DevAnonResolver(inner, userId);
}

/**
 * Resolves the `api-key` header value (`req.headers["api-key"]`). Only a missing
 * header counts as anonymous; an empty, comma-containing, or non-string value is
 * rejected like an unknown key.
 */
export async function authenticate(
  identity: IdentityResolver,
  header: string | string[] | undefined,
): Promise<Actor | null> {
  if (header === undefined) return identity.resolve(null);
  const key = apiKeyFromHeader(header);
  return key ? identity.resolve(key) : null;
}

export function apiKeyFromHeader(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== "string") return null;
  // node:http joins a repeated api-key header into one "a, b" string. Keys
  // never contain ",", so reject it here rather than rely on the resolver.
  if (header.includes(",")) return null;
  return header.trim() || null;
}
