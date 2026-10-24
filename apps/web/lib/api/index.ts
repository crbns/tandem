"use client";

import { createContext, useContext } from "react";
import type { TandemApi } from "./tandemApi";
import type { MockTandemApi } from "./mock";

export type { TandemApi } from "./tandemApi";
export * from "./types";
export { TandemApiError, normalizeError, type ApiErrorCode } from "./errors";

export const TandemApiContext = createContext<TandemApi | null>(null);
export const MockApiContext = createContext<MockTandemApi | null>(null);

/**
 * The Convex adapter or the mock, depending on NEXT_PUBLIC_USE_MOCKS (chosen
 * once in `app/providers.tsx`). Components only ever talk to the backend
 * through this hook.
 */
export function useTandemApi(): TandemApi {
  const api = useContext(TandemApiContext);
  if (!api) throw new Error("useTandemApi must be used inside <Providers>");
  return api;
}

/** Dev-only mock controls (e.g. "Simulate agent edit"). `null` outside mock mode. */
export function useMockControls(): MockTandemApi | null {
  return useContext(MockApiContext);
}
