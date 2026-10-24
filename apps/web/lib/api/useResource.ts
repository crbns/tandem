"use client";

import { useCallback, useEffect, useState } from "react";
import { normalizeError, type TandemApiError } from "./errors";

export type Resource<T> =
  | { status: "loading" }
  | { status: "error"; error: TandemApiError }
  | { status: "ready"; data: T };

/**
 * One-shot fetch with explicit loading/error/ready states. `load` must be
 * stable (wrap it in useCallback); a new identity triggers a refetch.
 * `reload()` refetches but keeps showing the previous data meanwhile.
 */
export function useResource<T>(load: () => Promise<T>) {
  const [resource, setResource] = useState<Resource<T>>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => {
        if (cancelled) return;
        setResource({ status: "ready", data });
        setRefreshing(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setResource({ status: "error", error: normalizeError(err) });
        setRefreshing(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, nonce]);

  const reload = useCallback(() => {
    setRefreshing(true);
    setNonce((n) => n + 1);
  }, []);

  return { resource, refreshing, reload };
}
