import { MockBackend } from "./mock.js";
import type { TandemBackend } from "./types.js";

export function createBackend(kind: string): TandemBackend {
  switch (kind) {
    case "mock":
      return new MockBackend();
    default:
      throw new Error(`Unknown TANDEM_BACKEND "${kind}". Supported: mock`);
  }
}
