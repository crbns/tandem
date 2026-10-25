import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import type { TandemApi } from "@/lib/api/tandemApi";
import { createMockApi, MOCK_WORKSPACE_ID } from "@/lib/api/mock";
import { contextSections } from "@/lib/context";
import { ContextFieldPanel } from "@/components/context/ContextFieldPanel";

// The suite runs in Node. A tiny hook harness renders the actual component's
// element tree and drives its edit/change/submit handlers without a DOM library.
const harness = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  api: null as TandemApi | null,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function find(
  tree: unknown,
  predicate: (element: Element) => boolean,
): Element {
  const found = elements(tree).find(predicate);
  if (!found) throw new Error("Expected component element");
  return found;
}

beforeEach(() => {
  harness.state = [];
  harness.cursor = 0;
});

describe("context field editing", () => {
  it.each([
    "goal",
    "scope",
    "constraint",
    "decision",
    "open_question",
  ] as const)(
    "preserves every newline when editing and saving existing multiline %s",
    async (field) => {
      const api = createMockApi({
        latencyMs: [0, 0],
        getActor: () => ({
          actorType: "human",
          userId: "owner",
          userName: "Owner",
        }),
      });
      harness.api = api;
      const original = "First line\nSecond line\n\nFourth line";
      const before = await api.getContextDetails(MOCK_WORKSPACE_ID);
      await api.updateContextField(MOCK_WORKSPACE_ID, {
        field,
        proposedValue: original,
        sourceFileIds: [],
        expectedVersion: before.version,
      });
      const context = await api.getContextDetails(MOCK_WORKSPACE_ID);
      const section = contextSections(context).find(
        (section) => section.field === field,
      )!;
      const entryIndex = section.entries.findIndex(
        (entry) => entry.text === original,
      );
      const update = vi.spyOn(api, "updateContextField");
      const onSaved = vi.fn();
      const render = () => {
        harness.cursor = 0;
        return ContextFieldPanel({
          workspaceId: MOCK_WORKSPACE_ID,
          ...section,
          version: context.version,
          canEdit: true,
          files: [],
          members: [],
          onSaved,
        });
      };
      let tree = render();
      const display = find(
        tree,
        (element) =>
          element.type === "p" && element.props.children === original,
      );
      expect(display.props.className).toContain("whitespace-pre-wrap");
      const edit = find(
        tree,
        (element) =>
          element.props.children === "Edit" &&
          (field === "goal" ||
            field === "scope" ||
            element.props["aria-label"] ===
              `Edit ${field === "open_question" ? "Open question" : field === "constraint" ? "Constraint" : "Decision"} ${entryIndex + 1}`),
      );
      (edit.props.onClick as () => void)();
      tree = render();
      const editor = find(
        tree,
        (element) => element.props.id === `value-${field}`,
      );
      // A single-line input strips LF characters in the browser before onChange.
      expect(editor.type).toBe("textarea");
      expect(editor.props.value).toBe(original);
      const edited = original.replace("Second line", "Second line!");
      (editor.props.onChange as (event: { target: { value: string } }) => void)(
        { target: { value: edited } },
      );
      tree = render();
      const form = find(tree, (element) => element.type === "form");
      (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
        preventDefault() {},
      });
      await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      expect(update).toHaveBeenCalledWith(
        MOCK_WORKSPACE_ID,
        expect.objectContaining({
          field,
          proposedValue: edited,
          expectedVersion: context.version,
        }),
      );
      const saved = contextSections(
        await api.getContextDetails(MOCK_WORKSPACE_ID),
      ).find((section) => section.field === field)!;
      expect(saved.entries[entryIndex]?.text).toBe(edited);
    },
  );
});
