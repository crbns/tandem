import type { ContextDetails, ContextEntry, ContextField } from "./api/types";
import type { TandemApi } from "./api/tandemApi";

export function contextSections(
  context: ContextDetails,
): { field: ContextField; label: string; entries: ContextEntry[] }[] {
  return [
    {
      field: "goal",
      label: "Goal",
      entries: context.goal ? [context.goal] : [],
    },
    {
      field: "scope",
      label: "Scope",
      entries: context.scope ? [context.scope] : [],
    },
    { field: "constraint", label: "Constraints", entries: context.constraints },
    { field: "decision", label: "Decisions", entries: context.decisions },
    { field: "ownership", label: "Ownership", entries: context.ownership },
    {
      field: "open_question",
      label: "Open questions",
      entries: context.openQuestions,
    },
  ];
}

/** Reload the visible feed from its head on events, including already-loaded pages. */
export async function loadContextPage(
  api: TandemApi,
  workspaceId: string,
  pageCount: number,
) {
  const [context, files, members, first] = await Promise.all([
    api.getContextDetails(workspaceId),
    api.listFiles(workspaceId),
    api.listWorkspaceMembers(workspaceId),
    api.listPublishedWork(workspaceId),
  ]);
  let result = first;
  const work = [...result.page];
  const cursors = new Set<string>();
  for (let page = 1; page < pageCount && !result.isDone; page++) {
    if (cursors.has(result.continueCursor))
      throw new Error("Repeated feed cursor");
    cursors.add(result.continueCursor);
    result = await api.listPublishedWork(workspaceId, result.continueCursor);
    work.push(...result.page);
  }
  return {
    context,
    files,
    members,
    work,
    hasMore: !result.isDone,
    loadedPages: pageCount,
  };
}
