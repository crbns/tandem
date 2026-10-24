import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { createConvexApi } from "@/lib/api/convex";
import type { TandemApi } from "@/lib/api/tandemApi";
import { UploadButton } from "@/components/files/UploadButton";

// Match the existing Node component harness: drive the actual change handler
// and rerender its element tree without adding a DOM dependency.
const harness = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, api: null as TandemApi | null, push: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => ({ current: null }),
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.state)) harness.state[index] = initial;
    return [harness.state[index], (value: unknown) => { harness.state[index] = value; }];
  },
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()), useTandemApi: () => harness.api,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: harness.push }) }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function render(props: Parameters<typeof UploadButton>[0] = { workspaceId: "ws" }) {
  harness.cursor = 0;
  return elements(UploadButton(props));
}
function select(props?: Parameters<typeof UploadButton>[0]) {
  const input = render(props).find((element) => element.type === "input")!;
  return (input.props.onChange as (event: unknown) => Promise<void>)({
    currentTarget: { files: [new File(["pdf"], "design.pdf", { type: "application/pdf" })], value: "design.pdf" },
  });
}
function expectIdleWithoutNavigation(tree = render()) {
  expect(tree.find((element) => element.type === "input")!.props.disabled).toBe(false);
  expect(harness.push).not.toHaveBeenCalled();
}
beforeEach(() => {
  harness.state = [];
  harness.cursor = 0;
  harness.push.mockClear();
  vi.useFakeTimers();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("upload phase deadlines", () => {
  it("disconnected Convex URL generation surfaces an error and clears busy", async () => {
    class ClosingSocket {
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      onopen = null;
      onerror = null;
      onmessage = null;
      constructor() { setTimeout(() => this.onclose?.({ code: 1006, reason: "disconnected" }), 1); }
      close() {}
      send() {}
    }
    const client = new ConvexReactClient("https://example.convex.cloud", {
      webSocketConstructor: ClosingSocket as unknown as typeof WebSocket,
      unsavedChangesWarning: false, logger: false,
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    harness.api = createConvexApi(client);
    try {
      const upload = select();
      expect(render().find((element) => element.type === "input")!.props.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expectIdleWithoutNavigation();
      await upload;
      expect(render().some((element) => element.props.role === "alert")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it("aborts a stalled blob transfer, clears busy, and never finalizes its late response", async () => {
    const mutation = vi.fn().mockResolvedValue("https://upload.example");
    let signal: AbortSignal | undefined;
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    harness.api = createConvexApi({ mutation } as unknown as ConvexReactClient);
    const upload = select();
    await vi.advanceTimersByTimeAsync(121_000);
    expectIdleWithoutNavigation();
    await upload;
    expect(signal?.aborted).toBe(true);
    expect(render().some((element) => element.props.role === "alert")).toBe(true);
    finish(new Response(JSON.stringify({ storageId: "stored" })));
    await vi.advanceTimersByTimeAsync(1);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("stalled finalize shows pending, clears busy, and skips navigation/callback (replacement=%s)", async (replacement) => {
    let finish!: (result: { id: string; version: number }) => void;
    const finalize = new Promise<{ id: string; version: number }>((resolve) => { finish = resolve; });
    const mutation = vi.fn(async (reference) => getFunctionName(reference) === "files:generateUploadUrl" ? "https://upload.example" : finalize);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ storageId: "stored" }))));
    harness.api = createConvexApi({ mutation } as unknown as ConvexReactClient);
    const onUploaded = vi.fn();
    const props = { workspaceId: "ws", ...(replacement ? { fileId: "file", expectedVersion: 1, onUploaded } : {}) };
    const upload = select(props);
    await vi.advanceTimersByTimeAsync(30_000);
    const tree = render(props);
    expectIdleWithoutNavigation(tree);
    await upload;
    expect(tree.some((element) => element.props.role === "alert")).toBe(false);
    expect(tree.find((element) => element.props.role === "status")?.props.children).toMatch(/taking longer.*file list/i);
    expect(onUploaded).not.toHaveBeenCalled();
    finish({ id: "file", version: 2 });
    await vi.advanceTimersByTimeAsync(1);
    expectIdleWithoutNavigation(render(props));
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("slow successful transfer and finalize still navigate to the created file", async () => {
    const mutation = vi.fn(async (reference) => {
      if (getFunctionName(reference) === "files:generateUploadUrl") return "https://upload.example";
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      return { id: "file", version: 1 };
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90_000));
      return new Response(JSON.stringify({ storageId: "stored" }));
    }));
    harness.api = createConvexApi({ mutation } as unknown as ConvexReactClient);
    const upload = select();
    await vi.advanceTimersByTimeAsync(106_000);
    await upload;
    expect(harness.push).toHaveBeenCalledWith("/w/ws/files/file");
    expect(render().find((element) => element.type === "input")!.props.disabled).toBe(false);
    expect(render().some((element) => element.props.role === "alert" || element.props.role === "status")).toBe(false);
  });
});
