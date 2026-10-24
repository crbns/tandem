import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import HistoryPage from "@/app/w/[workspaceId]/files/[fileId]/history/page";
import { FileHeader } from "@/components/files/FileHeader";
import { Breadcrumbs } from "@/components/files/Breadcrumbs";
import { createMockApi, MOCK_WORKSPACE_ID, type MockTandemApi } from "@/lib/api/mock";
import { loadFolderTrail } from "@/lib/api/useFolderTrail";
import type { Resource } from "@/lib/api/useResource";
import type { Crumb } from "@/lib/folders";

// The Node component harness: hooks are stubbed and each useResource call
// (the page's file load, then useFolderTrail's) answers from `resources`.
const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  resources: [] as Resource<unknown>[],
  loads: [] as Array<() => Promise<unknown>>,
  api: null as unknown,
  params: {} as Record<string, string>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: <T>(fn: T) => fn,
  useEffect: () => {},
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.state)) harness.state[index] = initial;
    return [harness.state[index], (value: unknown) => { harness.state[index] = value; }];
  },
}));
vi.mock("next/navigation", () => ({ useParams: () => harness.params }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useTandemApi: () => harness.api,
}));
vi.mock("@/lib/api/index", async (original) => ({
  ...(await original<typeof import("@/lib/api/index")>()),
  useTandemApi: () => harness.api,
}));
vi.mock("@/lib/api/useResource", () => ({
  useResource: (load: () => Promise<unknown>) => {
    const index = harness.loads.push(load) - 1;
    return { resource: harness.resources[index] ?? { status: "loading" }, refreshing: false, reload: () => {} };
  },
}));
vi.mock("@/lib/api/useWorkspace", () => ({ useWorkspaceRefresh: () => {} }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function find(node: unknown, type: unknown) {
  const found = elements(node).find((e) => e.type === type);
  if (!found) throw new Error("Element not found");
  return found;
}

describe("history page breadcrumbs", () => {
  let api: MockTandemApi;
  beforeEach(() => {
    api = createMockApi({ latencyMs: [0, 0], getActor: () => ({ actorType: "human", userId: "user_demo" }) });
    harness.api = api;
    harness.state = [];
    harness.resources = [];
  });

  function render() {
    harness.cursor = 0;
    harness.loads = [];
    return HistoryPage();
  }

  it("shows the file's folders, like the file page", async () => {
    const folder = await api.createFolder(MOCK_WORKSPACE_ID, { name: "api", parentId: "folder_specs" });
    const { id } = await api.createFile(MOCK_WORKSPACE_ID, { name: "notes.md", mimeType: "text/markdown", content: "# n", parentId: folder.id });
    harness.params = { workspaceId: MOCK_WORKSPACE_ID, fileId: id };
    const file = await api.readFile(id);
    harness.resources = [{ status: "ready", data: [file, await api.listRevisions(id)] }];

    render();
    // useFolderTrail loads the trail for the file's parent folder.
    const trail = await harness.loads[1]!();
    expect(trail).toEqual([{ id: "folder_specs", name: "specs" }, { id: folder.id, name: "api" }]);
    harness.resources[1] = { status: "ready", data: trail };

    const header = find(render(), FileHeader);
    expect(header.props.folders).toEqual(trail);
    const items = find(FileHeader(header.props as unknown as Parameters<typeof FileHeader>[0]), Breadcrumbs).props.items as Crumb[];
    expect(items.map((item) => item.label)).toEqual(["Workspace root", "specs", "api", "notes.md", "History"]);
    expect(items[2]!.href).toBe(`/w/${MOCK_WORKSPACE_ID}?folder=${folder.id}`);
  });

  it("has no folders for a file at the workspace root", async () => {
    expect(await loadFolderTrail(api, MOCK_WORKSPACE_ID, null)).toEqual([]);
    const listDirectory = vi.spyOn(api, "listDirectory");
    await loadFolderTrail(api, MOCK_WORKSPACE_ID, null);
    expect(listDirectory).not.toHaveBeenCalled();
  });
});
