import type { Actor } from "./backend/types.js";

/** A verified caller before the auth layer marks it as an agent. */
export type Identity = Omit<Actor, "actor_type">;

/**
 * Turns an API key into a verified identity. The dev resolver below will be
 * replaced by an OAuth/JWT verifier implementing the same interface.
 */
export interface IdentityResolver {
  /**
   * `key` is null when the request has no `api-key` header. Returns null when
   * the key is missing, unknown, expired, or invalid.
   */
  resolve(key: string | null): Promise<Identity | null>;
}

/** Resolves keys from a static map, e.g. TANDEM_DEV_TOKENS="key1:user_alex,key2:user_sam". */
export class DevTokenResolver implements IdentityResolver {
  private readonly tokens: Map<string, string>;

  constructor(spec: string) {
    this.tokens = new Map();
    for (const entry of spec.split(",")) {
      const [token, userId] = entry.trim().split(":");
      if (token && userId) this.tokens.set(token, userId);
    }
  }

  get size(): number {
    return this.tokens.size;
  }

  async resolve(key: string | null): Promise<Identity | null> {
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

  async resolve(key: string | null): Promise<Identity | null> {
    if (key === null) return { user_id: this.userId, client: "dev-anon" };
    return this.inner.resolve(key);
  }
}

/** Wraps `inner` in DevAnonResolver when TANDEM_DEV_ANON_USER is set; refuses outside mock dev. */
export function withDevAnon(
  inner: IdentityResolver,
  env: NodeJS.ProcessEnv,
): IdentityResolver {
  const userId = env.TANDEM_DEV_ANON_USER?.trim();
  if (!userId) return inner;
  if (
    env.NODE_ENV === "production" ||
    (env.TANDEM_BACKEND ?? "mock") !== "mock"
  ) {
    throw new Error(
      "TANDEM_DEV_ANON_USER is only allowed with TANDEM_BACKEND=mock outside NODE_ENV=production. Unset it.",
    );
  }
  return new DevAnonResolver(inner, userId);
}

/**
 * Resolves the `api-key` header value (`req.headers["api-key"]`). Only a missing
 * header counts as anonymous; an empty or repeated header is rejected like an
 * unknown key. Every MCP caller is an agent: actor_type is set here, never from
 * tool arguments or the resolver.
 */
export async function authenticate(
  identity: IdentityResolver,
  header: string | string[] | undefined,
): Promise<Actor | null> {
  const key = header === undefined ? null : apiKeyFromHeader(header);
  if (header !== undefined && !key) return null;
  const resolved = await identity.resolve(key);
  return resolved && { ...resolved, actor_type: "agent" };
}

export function apiKeyFromHeader(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== "string") return null;
  return header.trim() || null;
}
