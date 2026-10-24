import type { Actor, TandemBackend } from "./backend/types.js";

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

/**
 * Forwards the caller's token to Convex, which is the authority: Convex hashes
 * it, checks the agent connection and membership, and returns who it belongs
 * to. The token rides along on the actor as `credential` so every backend call
 * is authorized by Convex again; this server never decides identity itself.
 */
export class ConvexTokenResolver implements IdentityResolver {
  constructor(
    private readonly verifier: {
      verifyToken(
        token: string,
      ): Promise<{ userId: string; client: string } | null>;
    },
  ) {}

  async resolve(key: string | null): Promise<Identity | null> {
    if (!key) return null;
    const verified = await this.verifier.verifyToken(key);
    return (
      verified && {
        user_id: verified.userId,
        client: verified.client,
        credential: key,
      }
    );
  }
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
 * Every MCP caller is an agent: actor_type is set here, never from tool arguments or the resolver.
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

/**
 * With `acceptBearer`, the token may come from `Authorization: Bearer <token>`
 * or the `api-key` header. Returns a value for `authenticate`: undefined when
 * neither header is present, "" (rejected) for a malformed Authorization
 * header or two headers carrying different tokens.
 */
export function credentialHeader(
  headers: { authorization?: string; "api-key"?: string | string[] },
  acceptBearer: boolean,
): string | string[] | undefined {
  const apiKey = headers["api-key"];
  if (!acceptBearer || headers.authorization === undefined) return apiKey;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization);
  if (!match) return "";
  const bearer = match[1]!;
  if (apiKey !== undefined && apiKeyFromHeader(apiKey) !== bearer) return "";
  return bearer;
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
