import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { MoveDialog, type MoveItem } from "@/components/files/MoveDialog";
import { FolderActions } from "@/components/files/FolderActions";
import { createMockApi, MOCK_WORKSPACE_ID, type MockTandemApi } from "@/lib/api/mock";
import { TandemApiError } from "@/lib/api/errors";
import type { TandemApi } from "@/lib/api/tandemApi";

// The existing Node component harness: hooks are stubbed, components are
// called as functions, and their element trees are searched and driven.
const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => unknown>,
  api: null as TandemApi | null,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "test-id",
  useEffect: (effect: () => unknown) => {
    harness.effects.push(effect);
  },
  useState(initial: unknown) {
    const index = harness.cursor++;
    if (!(index in harness.state)) harness.state[index] = initial;
    return [
      harness.state[index],
      (value: unknown) => {
        harness.state[index] = value;
      },
    ];
  },
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useTandemApi: () => harness.api,
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function find(node: unknown, predicate: (element: Element) => boolean) {
  const found = elements(node).find(predicate);
  if (!found) throw new Error("Element not found");
  return found;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const submit = (tree: unknown) =>
  (find(tree, (e) => e.type === "form").props.onSubmit as (e: { preventDefault(): void }) => Promise<void>)({
    preventDefault() {},
  });

let api: MockTandemApi;
beforeEach(() => {
  harness.state = [];
  harness.cursor = 0;
  harness.effects = [];
  api = createMockApi({ latencyMs: [0, 0], getActor: () => ({ actorType: "human", userId: "user_demo" }) });
  harness.api = api;
});

describe("MoveDialog", () => {
  async function openDialog(item: MoveItem, onMove: (parentId: string | null) => Promise<unknown>) {
    const onOpenChange = vi.fn();
    const onChanged = vi.fn();
    const render = () => {
      harness.cursor = 0;
      harness.effects = [];
      return MoveDialog({ workspaceId: MOCK_WORKSPACE_ID, item, open: true, onOpenChange, onMove, onChanged });
    };
    render();
    harness.effects.forEach((effect) => effect()); // loads the folder tree
    await flush();
    return { render, onOpenChange, onChanged };
  }
  const radio = (tree: unknown, label: string) => find(tree, (e) => e.props.role === "radio" && e.props["aria-label"] === label);

  it("moves a file into the picked folder, then closes and refreshes", async () => {
    const specs = (await api.listFolderTree(MOCK_WORKSPACE_ID))[0]!;
    const file = await api.readFile("file_brief");
    const { render, onOpenChange, onChanged } = await openDialog(
      { kind: "file", id: file.id, name: file.name, parentId: file.parentId },
      (parentId) => api.moveFile(file.id, parentId, file.version),
    );

    let tree = render();
    expect(radio(tree, "Workspace root").props.disabled).toBe(true); // already there
    expect(find(tree, (e) => e.props.type === "submit").props.disabled).toBe(true);
    (radio(tree, "/specs").props.onClick as () => void)();
    tree = render();
    expect(radio(tree, "/specs").props["aria-checked"]).toBe(true);
    await submit(tree);

    expect(await api.readFile(file.id)).toMatchObject({ parentId: specs.id, version: file.version + 1, path: "/specs/brief.md" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("never offers a folder's own subtree, and reports a conflict instead of closing", async () => {
    const a = await api.createFolder(MOCK_WORKSPACE_ID, { name: "a" });
    await api.createFolder(MOCK_WORKSPACE_ID, { name: "b", parentId: a.id });
    const onMove = vi.fn(async () => {
      throw new TandemApiError("VERSION_CONFLICT", { currentRevision: 2 });
    });
    const { render, onOpenChange, onChanged } = await openDialog({ kind: "folder", id: a.id, name: "a", parentId: null }, onMove);

    let tree = render();
    expect(radio(tree, "/a").props.disabled).toBe(true);
    expect(radio(tree, "/a/b").props.disabled).toBe(true);
    expect(radio(tree, "/specs").props.disabled).toBe(false);
    (radio(tree, "/specs").props.onClick as () => void)();
    await submit(render());

    tree = render();
    expect(onMove).toHaveBeenCalledWith((await api.listFolderTree(MOCK_WORKSPACE_ID)).find((f) => f.path === "/specs")!.id);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(find(tree, (e) => e.props.role === "alert").props.children).toBe(
      "“a” changed since you opened it. Close this, review it and try again.",
    );
  });
});

describe("FolderActions", () => {
  it("shows what a delete removes before deleting the whole subtree", async () => {
    const a = await api.createFolder(MOCK_WORKSPACE_ID, { name: "a" });
    const b = await api.createFolder(MOCK_WORKSPACE_ID, { name: "b", parentId: a.id });
    await api.createFile(MOCK_WORKSPACE_ID, { name: "x.md", mimeType: "text/markdown", content: "", parentId: b.id });
    const changed = vi.fn();
    const render = () => {
      harness.cursor = 0;
      return FolderActions({ folder: a, onChanged: changed });
    };

    (find(render(), (e) => e.props["aria-label"] === "Delete folder a").props.onClick as () => void)();
    await flush();
    const tree = render();
    const description = elements(tree).find((e) => typeof e.props.children === "string" && e.props.children.startsWith("Remove"));
    expect(description?.props.children).toBe("Remove “a” and everything in it: 2 folders and 1 file? Revision history is kept.");

    await submit(tree);
    expect(changed).toHaveBeenCalledOnce();
    expect((await api.listFolderTree(MOCK_WORKSPACE_ID)).map((f) => f.path)).toEqual(["/specs"]);
  });

  it("renames with the folder's revision and explains a name taken by a file", async () => {
    const folder = (await api.listFolderTree(MOCK_WORKSPACE_ID))[0]!;
    const render = () => {
      harness.cursor = 0;
      return FolderActions({ folder });
    };
    (find(render(), (e) => e.props["aria-label"] === "Rename folder specs").props.onClick as () => void)();
    (find(render(), (e) => e.props.id === "test-id").props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: "Notes.TXT" },
    });
    await submit(render());
    expect(find(render(), (e) => e.props.role === "alert").props.children).toBe(
      "A file named “notes.txt” already exists here. Names ignore case and extra spaces; pick another.",
    );
  });
});
