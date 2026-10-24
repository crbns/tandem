import { ConvexBackend } from "./convex.js";
import { MockBackend } from "./mock.js";
import type { TandemBackend } from "./types.js";

export function createBackend(
  kind: string,
  env: NodeJS.ProcessEnv = {},
): TandemBackend {
  switch (kind) {
    case "mock":
      return new MockBackend();
    case "convex": {
      const url = env.CONVEX_URL?.trim();
      if (!url) throw new Error("TANDEM_BACKEND=convex requires CONVEX_URL.");
      return new ConvexBackend(url);
    }
    default:
      throw new Error(
        `Unknown TANDEM_BACKEND "${kind}". Supported: mock, convex`,
      );
  }
}
