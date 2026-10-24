import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { FileActions } from "@/components/files/FileActions";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import type { TandemApi } from "@/lib/api/tandemApi";

const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  api: null as TandemApi | null,
  push: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "test-name",
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: harness.push }),
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

beforeEach(() => {
  harness.state = [];
  harness.cursor = 0;
  harness.push.mockReset();
});

describe("file action dialogs", () => {
  it("requires a separate confirmation before deleting and returns to the list", async () => {
    const api = createMockApi({
      latencyMs: [0, 0],
      getActor: () => ({ actorType: "human", userId: "user_demo" }),
    });
    harness.api = api;
    const file = await api.readFile("file_brief");
    const remove = vi.spyOn(api, "deleteFile");
    const changed = vi.fn();
    const render = () => {
      harness.cursor = 0;
      return FileActions({
        file,
        onChanged: changed,
        redirectAfterDelete: true,
      });
    };
    let tree = render();
    (
      find(tree, (e) => e.props["aria-label"] === `Delete ${file.name}`).props
        .onClick as () => void
    )();
    tree = render();
    expect(remove).not.toHaveBeenCalled();
    (
      find(tree, (e) => e.props.children === "Cancel").props
        .onClick as () => void
    )();
    render();
    expect(remove).not.toHaveBeenCalled();
    (
      find(render(), (e) => e.props["aria-label"] === `Delete ${file.name}`)
        .props.onClick as () => void
    )();
    tree = render();
    await (
      find(tree, (e) => e.type === "form").props.onSubmit as (e: {
        preventDefault(): void;
      }) => Promise<void>
    )({ preventDefault() {} });
    expect(remove).toHaveBeenCalledExactlyOnceWith(file.id, file.version);
    expect(changed).toHaveBeenCalledOnce();
    expect(harness.push).toHaveBeenCalledWith(`/w/${MOCK_WORKSPACE_ID}`);
    await expect(api.readFile(file.id)).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });
  it("returns to the folder the deleted file was in", async () => {
    const api = createMockApi({
      latencyMs: [0, 0],
      getActor: () => ({ actorType: "human", userId: "user_demo" }),
    });
    harness.api = api;
    const { version } = await api.moveFile("file_brief", "folder_specs", (await api.readFile("file_brief")).version);
    const file = await api.readFile("file_brief");
    expect(file).toMatchObject({ parentId: "folder_specs", version });
    const render = () => {
      harness.cursor = 0;
      return FileActions({ file, redirectAfterDelete: true });
    };
    (
      find(render(), (e) => e.props["aria-label"] === `Delete ${file.name}`)
        .props.onClick as () => void
    )();
    await (
      find(render(), (e) => e.type === "form").props.onSubmit as (e: {
        preventDefault(): void;
      }) => Promise<void>
    )({ preventDefault() {} });
    expect(harness.push).toHaveBeenCalledExactlyOnceWith(`/w/${MOCK_WORKSPACE_ID}?folder=folder_specs`);
  });
  it("keeps a newer edit when deletion is confirmed from stale metadata", async () => {
    const api = createMockApi({
      latencyMs: [0, 0],
      getActor: () => ({ actorType: "human", userId: "user_demo" }),
    });
    harness.api = api;
    const file = await api.readFile("file_brief");
    const changed = vi.fn();
    const render = () => {
      harness.cursor = 0;
      return FileActions({
        file,
        onChanged: changed,
        redirectAfterDelete: true,
      });
    };
    (
      find(render(), (e) => e.props["aria-label"] === `Delete ${file.name}`)
        .props.onClick as () => void
    )();
    await api.updateFileContent(file.id, {
      content: "a newer edit",
      expectedVersion: file.version,
    });
    await (
      find(render(), (e) => e.type === "form").props.onSubmit as (e: {
        preventDefault(): void;
      }) => Promise<void>
    )({ preventDefault() {} });
    expect((await api.readFile(file.id)).content).toBe("a newer edit");
    expect(harness.push).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    expect(find(render(), (e) => e.props.role === "alert").props.children).toBe(
      "The file changed. Review it and try again.",
    );
  });
});
