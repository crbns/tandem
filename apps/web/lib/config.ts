// NEXT_PUBLIC_* must be referenced literally so Next can inline them at build time.
export const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "true";
export const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
export const DEFAULT_WORKSPACE_ID =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID ?? "";
