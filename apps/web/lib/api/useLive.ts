"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTandemApi } from "./index";
import { normalizeError } from "./errors";
import type { Resource } from "./useResource";
import type { ActivityKind, AgentNetwork, TimelineItem } from "./types";
import { mergeTimeline, takeArrivals } from "../live";

/** The Live page's network: reactive, so it changes the moment an assistant calls a tool. */
export function useAgentNetwork(workspaceId: string) {
  const api = useTandemApi();
  const [resource, setResource] = useState<Resource<AgentNetwork>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(
    () =>
      api.watchAgentNetwork(workspaceId, {
        onData: (data) => setResource({ status: "ready", data }),
        onError: (error) => setResource((current) => (current.status === "ready" ? current : { status: "error", error })),
      }),
    [api, workspaceId, nonce],
  );
  const retry = useCallback(() => {
    setResource({ status: "loading" });
    setNonce((n) => n + 1);
  }, []);
  return { resource, retry };
}

const PAGE_SIZE = 50;

/**
 * The unfiltered head page the network listens to for pulses. Same args as the
 * unfiltered timeline, so the Convex client shares one subscription for both.
 */
const ARRIVALS_PAGE = PAGE_SIZE;

/**
 * Calls `onArrive` with each timeline item that shows up after the first
 * result (oldest first). The initial load never counts as an arrival, so
 * opening the page doesn't replay history.
 */
export function useActivityArrivals(workspaceId: string, onArrive: (items: TimelineItem[]) => void) {
  const api = useTandemApi();
  const callback = useRef(onArrive);
  useEffect(() => {
    callback.current = onArrive;
  });
  useEffect(() => {
    let seen: Set<string> | null = null;
    return api.watchTimeline(workspaceId, { limit: ARRIVALS_PAGE }, {
      onData: ({ items }) => {
        if (!seen) {
          seen = new Set(items.map((item) => item.id));
          return;
        }
        const fresh = takeArrivals(seen, items);
        if (fresh.length > 0) callback.current(fresh);
      },
      onError: () => {}, // the timeline panel reports errors
    });
  }, [api, workspaceId]);
}

/** Older pages fetched in one "Load more" while they keep coming back empty. */
const MAX_EMPTY_PAGES = 5;

interface Feed {
  items: TimelineItem[];
  nextBefore: number | null;
  /** Ids that arrived after the first page, for the entry motion. */
  fresh: ReadonlySet<string>;
}

/**
 * The filtered timeline: a reactive head page merged into everything loaded
 * so far, plus older pages on demand. A filter change starts over.
 */
export function useTimeline(workspaceId: string, connectionId: string | null, kinds: ActivityKind[]) {
  const api = useTandemApi();
  const kindsKey = kinds.join(",");
  const [state, setState] = useState<Resource<Feed>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<ReturnType<typeof normalizeError> | null>(null);
  // Bumped per subscription so a late older page can't land in a newer filter.
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    setState({ status: "loading" });
    setLoadingMore(false);
    setLoadMoreError(null);
    let seen: Set<string> | null = null;
    const query = {
      limit: PAGE_SIZE,
      ...(connectionId ? { connectionId } : {}),
      ...(kindsKey ? { kinds: kindsKey.split(",") as ActivityKind[] } : {}),
    };
    const unsubscribe = api.watchTimeline(workspaceId, query, {
      onData: (page) => {
        if (gen !== generation.current) return;
        if (!seen) {
          seen = new Set(page.items.map((item) => item.id));
          setState({ status: "ready", data: { items: page.items, nextBefore: page.nextBefore, fresh: new Set() } });
          return;
        }
        const arrived = takeArrivals(seen, page.items);
        setState((current) => {
          if (current.status !== "ready") return current;
          const fresh = arrived.length > 0 ? new Set([...current.data.fresh, ...arrived.map((item) => item.id)]) : current.data.fresh;
          return { status: "ready", data: { ...current.data, items: mergeTimeline(current.data.items, page.items), fresh } };
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
  }, [api, workspaceId, connectionId, kindsKey, nonce]);

  const before = state.status === "ready" ? state.data.nextBefore : null;
  const loadMore = useCallback(async () => {
    if (before === null) return;
    const gen = generation.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      // A filtered page can come back short or even empty with more behind it
      // (the backend scans a bounded window), so keep going a few pages.
      let cursor: number | null = before;
      const found: TimelineItem[] = [];
      for (let i = 0; i < MAX_EMPTY_PAGES && cursor !== null && found.length === 0; i++) {
        const page = await api.listTimeline(workspaceId, {
          before: cursor,
          limit: PAGE_SIZE,
          ...(connectionId ? { connectionId } : {}),
          ...(kindsKey ? { kinds: kindsKey.split(",") as ActivityKind[] } : {}),
        });
        if (gen !== generation.current) return;
        found.push(...page.items);
        cursor = page.nextBefore;
      }
      const nextBefore = cursor;
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", data: { ...current.data, items: mergeTimeline(current.data.items, found), nextBefore } }
          : current,
      );
    } catch (err) {
      if (gen === generation.current) setLoadMoreError(normalizeError(err));
    } finally {
      if (gen === generation.current) setLoadingMore(false);
    }
  }, [api, workspaceId, connectionId, kindsKey, before]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { state, loadMore, loadingMore, loadMoreError, retry };
}
