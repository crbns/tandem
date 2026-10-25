"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTandemApi } from "./index";
import { normalizeError, type TandemApiError } from "./errors";
import type { Resource } from "./useResource";
import type { ActivityEvent, ActivitySource, ContextChanges, EntryHistory, ObservedContext, Subscriber } from "./types";

/**
 * A reactive query as a Resource: Convex pushes every change (mock mode pings
 * on its own writes), so nothing here polls. An error after the first result
 * keeps the last good data on screen.
 */
function useWatch<T>(watch: (subscriber: Subscriber<T>) => () => void, key: string | null) {
  const [resource, setResource] = useState<Resource<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const watchRef = useRef(watch);
  useEffect(() => {
    watchRef.current = watch;
  });
  useEffect(() => {
    if (key === null) return;
    setResource({ status: "loading" });
    return watchRef.current({
      onData: (data) => setResource({ status: "ready", data }),
      onError: (error) => setResource((current) => (current.status === "ready" ? current : { status: "error", error })),
    });
  }, [key, nonce]);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { resource, retry };
}

/** Observed context entries and the context manager's status. */
export function useObservedContext(workspaceId: string) {
  const api = useTandemApi();
  return useWatch<ObservedContext>((s) => api.watchObservedContext(workspaceId, s), `${workspaceId}`);
}

/** Observed-context revisions (newest first) and context-manager runs. */
export function useContextChanges(workspaceId: string) {
  const api = useTandemApi();
  return useWatch<ContextChanges>((s) => api.watchContextChanges(workspaceId, s), `${workspaceId}`);
}

/** One entry's history and evidence; idle while `entryId` is null. */
export function useEntryHistory(workspaceId: string, entryId: string | null) {
  const api = useTandemApi();
  return useWatch<EntryHistory>(
    (s) => api.watchEntryHistory(workspaceId, entryId!, s),
    entryId === null ? null : `${workspaceId}:${entryId}`,
  );
}

const PAGE_SIZE = 50;
/** Older pages fetched in one "Load more" while they keep coming back empty. */
const MAX_EMPTY_PAGES = 5;

interface Feed {
  items: ActivityEvent[];
  nextBefore: string | null;
  /** Ids that arrived after the first page, for the entry motion. */
  fresh: ReadonlySet<string>;
}

/** Newest first, de-duplicated by id: the reactive head page over everything loaded. */
function mergeEvents(loaded: readonly ActivityEvent[], incoming: readonly ActivityEvent[]): ActivityEvent[] {
  const byId = new Map(loaded.map((e) => [e.id, e]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The raw activity feed: a reactive head page merged into everything loaded so
 * far, plus older pages on demand. A filter change starts over.
 */
export function useActivityEvents(workspaceId: string, sources: ActivitySource[], connectionId: string | null) {
  const api = useTandemApi();
  const sourcesKey = sources.join(",");
  const [state, setState] = useState<Resource<Feed>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<TandemApiError | null>(null);
  // Bumped per subscription so a late older page can't land in a newer filter.
  const generation = useRef(0);

  const queryFor = useCallback(
    (before?: string) => ({
      limit: PAGE_SIZE,
      ...(before !== undefined ? { before } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(sourcesKey ? { sources: sourcesKey.split(",") as ActivitySource[] } : {}),
    }),
    [connectionId, sourcesKey],
  );

  useEffect(() => {
    const gen = ++generation.current;
    setState({ status: "loading" });
    setLoadingMore(false);
    setLoadMoreError(null);
    let seen: Set<string> | null = null;
    const unsubscribe = api.watchActivityEvents(workspaceId, queryFor(), {
      onData: (page) => {
        if (gen !== generation.current) return;
        if (!seen) {
          seen = new Set(page.items.map((e) => e.id));
          setState({ status: "ready", data: { items: page.items, nextBefore: page.nextBefore, fresh: new Set() } });
          return;
        }
        const arrived = page.items.filter((e) => !seen!.has(e.id));
        for (const e of arrived) seen.add(e.id);
        setState((current) => {
          if (current.status !== "ready") return current;
          const fresh = arrived.length > 0 ? new Set([...current.data.fresh, ...arrived.map((e) => e.id)]) : current.data.fresh;
          return { status: "ready", data: { ...current.data, items: mergeEvents(current.data.items, page.items), fresh } };
        });
      },
      onError: (error) => {
        if (gen !== generation.current) return;
        setState((current) => (current.status === "ready" ? current : { status: "error", error }));
      },
    });
    return () => {
      generation.current++;
      unsubscribe();
    };
  }, [api, workspaceId, queryFor, nonce]);

  const before = state.status === "ready" ? state.data.nextBefore : null;
  const loadMore = useCallback(async () => {
    if (before === null) return;
    const gen = generation.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      // A filtered page can come back short or empty with more behind it.
      let cursor: string | null = before;
      const found: ActivityEvent[] = [];
      for (let i = 0; i < MAX_EMPTY_PAGES && cursor !== null && found.length === 0; i++) {
        const page = await api.listActivityEvents(workspaceId, queryFor(cursor));
        if (gen !== generation.current) return;
        found.push(...page.items);
        cursor = page.nextBefore;
      }
      const nextBefore = cursor;
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", data: { ...current.data, items: mergeEvents(current.data.items, found), nextBefore } }
          : current,
      );
    } catch (err) {
      if (gen === generation.current) setLoadMoreError(normalizeError(err));
    } finally {
      if (gen === generation.current) setLoadingMore(false);
    }
  }, [api, workspaceId, queryFor, before]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { state, loadMore, loadingMore, loadMoreError, retry };
}
