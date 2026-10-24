import type { Actor } from "./backend/types.js";

/**
 * Turns a bearer token into a verified identity. The dev resolver below will be
 * replaced by an OAuth/JWT verifier implementing the same interface.
 */
export interface IdentityResolver {
  /** Returns null when the token is unknown, expired, or invalid. */
  resolve(token: string): Promise<Actor | null>;
}

/** Resolves tokens from a static map, e.g. TANDEM_DEV_TOKENS="token1:user_alex,token2:user_sam". */
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

  async resolve(token: string): Promise<Actor | null> {
    const userId = this.tokens.get(token);
    return userId ? { user_id: userId, client: "dev-token" } : null;
  }
}

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}
