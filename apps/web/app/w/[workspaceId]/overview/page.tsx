"use client";

import Link from "next/link";
import { useCallback, useMemo, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { ArrowRightIcon, FolderIcon, RotateCwIcon } from "lucide-react";
import { useTandemApi } from "@/lib/api";
import { useResource, type Resource } from "@/lib/api/useResource";
import { useArrivedFiles, useWorkspaceFiles, useWorkspaceRefresh } from "@/lib/api/useWorkspace";
import { clientName } from "@/lib/actors";
import { folderHref, plural } from "@/lib/folders";
import { condenseTree, contextDigest, recentFiles, sortMembers, summarizeAgents, RECENT_ACTIVITY_MS } from "@/lib/overview";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import type { AgentActivity, ContextDetails, FileSummary, FolderSummary, WorkspaceMember } from "@/lib/api/types";
import { CustodyMark } from "@/components/common/CustodyMark";
import { ErrorState } from "@/components/common/ErrorState";
import { InviteDialog } from "@/components/common/InviteDialog";
import { TeamDoingCard } from "@/components/intelligence/TeamDoingCard";
import { ArrivalGlow } from "@/components/files/ArrivalGlow";
import { FileIcon } from "@/components/files/FileIcon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Entries shown per context list before "and N more". */
const DIGEST_ENTRIES = 2;

export default function OverviewPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const api = useTandemApi();

  const loadAgents = useCallback(() => api.listAgentActivity(workspaceId), [api, workspaceId]);
  const agents = useResource(loadAgents);
  const loadFolders = useCallback(() => api.listFolderTree(workspaceId), [api, workspaceId]);
  const folders = useResource(loadFolders);
  // The layout already lists the files for the rail's count; reuse that list.
  const workspaceFiles = useWorkspaceFiles();
  const files = useMemo(
    () => ({
      resource: bothReady(folders.resource, workspaceFiles.resource, (folders, files) => ({ folders, files })),
      refreshing: folders.refreshing || workspaceFiles.refreshing,
    }),
    [folders.resource, folders.refreshing, workspaceFiles.resource, workspaceFiles.refreshing],
  );
  const loadContext = useCallback(() => api.getContextDetails(workspaceId), [api, workspaceId]);
  const context = useResource(loadContext);
  const loadMembers = useCallback(() => api.listWorkspaceMembers(workspaceId), [api, workspaceId]);
  const members = useResource(loadMembers);

  const { reload: reloadAgents } = agents;
  const { reload: reloadFolders } = folders;
  const { reload: reloadWorkspaceFiles } = workspaceFiles;
  const reloadFiles = useCallback(() => {
    reloadFolders();
    reloadWorkspaceFiles();
  }, [reloadFolders, reloadWorkspaceFiles]);
  const { reload: reloadContext } = context;
  const { reload: reloadMembers } = members;
  const reloadAll = useCallback(() => {
    reloadAgents();
    reloadFiles();
    reloadContext();
    reloadMembers();
  }, [reloadAgents, reloadFiles, reloadContext, reloadMembers]);
  // MCP writes, connects, approvals and invite joins record workspace events.
  // Read-only MCP calls only bump connection times, which show on focus or Refresh.
  useWorkspaceRefresh(workspaceId, reloadAll);
  const refreshing = agents.refreshing || files.refreshing || context.refreshing || members.refreshing;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <h1 className="text-2xl font-bold leading-8 tracking-[-0.01em]">Overview</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reloadAll} disabled={refreshing} aria-label="Refresh overview">
            <RotateCwIcon className={cn(refreshing && "animate-spin")} />
            Refresh
          </Button>
          <InviteDialog workspaceId={workspaceId} />
        </div>
      </div>

      <AgentsPanel workspaceId={workspaceId} resource={agents.resource} onRetry={agents.reload} retrying={agents.refreshing} />

      <TeamDoingCard workspaceId={workspaceId} />

      <MembersPanel resource={members.resource} onRetry={members.reload} retrying={members.refreshing} />

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <FilesPanel workspaceId={workspaceId} resource={files.resource} onRetry={reloadFiles} retrying={files.refreshing} />
        <ContextPanel workspaceId={workspaceId} resource={context.resource} onRetry={context.reload} retrying={context.refreshing} />
      </div>
    </div>
  );
}

/** Ready once both are, failing with the first error. */
function bothReady<A, B, T>(a: Resource<A>, b: Resource<B>, combine: (a: A, b: B) => T): Resource<T> {
  if (a.status === "error") return a;
  if (b.status === "error") return b;
  if (a.status === "loading" || b.status === "loading") return { status: "loading" };
  return { status: "ready", data: combine(a.data, b.data) };
}

function Panel({
  id,
  title,
  href,
  linkLabel,
  children,
}: {
  id: string;
  title: string;
  /** Omit both for a panel with no page of its own. */
  href?: string;
  linkLabel?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-md border bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {href && (
          <Link
            href={href}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {linkLabel}
            <ArrowRightIcon className="size-3.5" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

interface PanelProps<T> {
  workspaceId: string;
  resource: Resource<T>;
  onRetry: () => void;
  retrying: boolean;
}

function AgentsPanel({ workspaceId, resource, onRetry, retrying }: PanelProps<AgentActivity[]>) {
  const now = useNow();
  const summary = resource.status === "ready" ? summarizeAgents(resource.data, now) : null;
  return (
    <Panel id="overview-agents" title="Assistants" href={`/w/${workspaceId}/assistants`} linkLabel="Manage assistants">
      {resource.status === "loading" && <Skeleton className="h-16" aria-label="Loading assistants" />}
      {resource.status === "error" && <ErrorState error={resource.error} onRetry={onRetry} retrying={retrying} />}
      {summary && (
        <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
          <Stat value={summary.connected} label={summary.connected === 1 ? "assistant connected" : "assistants connected"} />
          <Stat
            value={summary.recentlyActive}
            label={`recently active (last ${RECENT_ACTIVITY_MS / 60_000} min)`}
            accent={summary.recentlyActive > 0}
          />
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5 text-xs text-muted-foreground">
            {summary.byClient.length > 0 && (
              <ul aria-label="Connections by assistant" className="flex flex-wrap gap-1.5">
                {summary.byClient.map(({ client, count }) => (
                  <li key={client} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-foreground">
                    <CustodyMark kind="agent" />
                    {clientName(client)}
                    <span className="text-muted-foreground">{count}</span>
                  </li>
                ))}
              </ul>
            )}
            <p>
              {summary.connected === 0
                ? "No assistants are connected yet."
                : summary.lastHeardAt === null
                  ? "Tandem hasn't heard from any of them yet."
                  : (
                      <>
                        Tandem last heard from one{" "}
                        <span title={formatAbsolute(summary.lastHeardAt)}>{formatRelative(summary.lastHeardAt, now)}</span>.
                      </>
                    )}{" "}
              Times show the last MCP action or sync, not whether an assistant is running.
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}

const ROLE_LABEL: Record<WorkspaceMember["role"], string> = { owner: "Owner", admin: "Admin", member: "Member" };

function MembersPanel({ resource, onRetry, retrying }: Omit<PanelProps<WorkspaceMember[]>, "workspaceId">) {
  return (
    <Panel id="overview-members" title="Members">
      {resource.status === "loading" && <Skeleton className="h-10" aria-label="Loading members" />}
      {resource.status === "error" && <ErrorState error={resource.error} onRetry={onRetry} retrying={retrying} />}
      {resource.status === "ready" && (
        <>
          <p className="label-caps text-muted-foreground">{plural(resource.data.length, "member")}</p>
          <ul aria-label="Workspace members" className="flex flex-wrap gap-1.5 text-sm">
            {sortMembers(resource.data).map((member) => (
              <li key={member.userId} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5">
                <CustodyMark kind="human" />
                <span className="font-medium">{member.name}</span>
                <span className="text-xs text-muted-foreground">{ROLE_LABEL[member.role]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function Stat({ value, label, accent = false }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("text-3xl font-bold tabular-nums leading-none", accent && "text-agent")}>{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

function FilesPanel({
  workspaceId,
  resource,
  onRetry,
  retrying,
}: PanelProps<{ folders: FolderSummary[]; files: FileSummary[] }>) {
  const now = useNow();
  const fileHref = (file: FileSummary) => `/w/${workspaceId}/files/${file.id}`;
  // Only the relative times need `now`; the tree and sort stay put between ticks.
  const data = resource.status === "ready" ? resource.data : null;
  const tree = useMemo(() => data && condenseTree(data.folders, data.files), [data]);
  const recent = useMemo(() => data && recentFiles(data.files), [data]);
  // The landing page: an assistant's new or saved file lights up here too.
  const arrived = useArrivedFiles();
  return (
    <Panel id="overview-files" title="Files" href={folderHref(workspaceId, null)} linkLabel="Open files">
      {resource.status === "loading" && <Skeleton className="h-48" aria-label="Loading files" />}
      {resource.status === "error" && <ErrorState error={resource.error} onRetry={onRetry} retrying={retrying} />}
      {data && tree && recent && (() => {
        const { folders, files } = data;
        if (folders.length === 0 && files.length === 0) {
          return <p className="text-sm text-muted-foreground">No files yet.</p>;
        }
        return (
          <>
            <p className="label-caps text-muted-foreground">
              {plural(files.length, "file")} · {plural(folders.length, "folder")}
            </p>
            <ul aria-label="Workspace tree" className="flex flex-col text-sm">
              {tree.rows.map((row) =>
                row.kind === "folder" ? (
                  <li key={row.folder.id}>
                    <Link
                      href={folderHref(workspaceId, row.folder.id)}
                      className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-accent"
                      style={{ paddingLeft: `${0.375 + (row.depth - 1) * 1.25}rem` }}
                    >
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{row.folder.name}</span>
                      <span className="text-xs text-muted-foreground">{plural(row.fileCount, "file")}</span>
                    </Link>
                  </li>
                ) : (
                  <li key={row.file.id} className="relative isolate">
                    {arrived.has(row.file.id) && <ArrivalGlow key={arrived.get(row.file.id)!.at} mark={arrived.get(row.file.id)!} />}
                    <Link href={fileHref(row.file)} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-accent">
                      <FileIcon mimeType={row.file.mimeType} />
                      <span className="min-w-0 flex-1 truncate">{row.file.name}</span>
                    </Link>
                  </li>
                ),
              )}
            </ul>
            {(tree.hiddenFolders > 0 || tree.hiddenFiles > 0) && (
              <p className="text-xs text-muted-foreground">
                and{" "}
                {[
                  tree.hiddenFolders > 0 && `${plural(tree.hiddenFolders, "more folder")}`,
                  tree.hiddenFiles > 0 && `${plural(tree.hiddenFiles, "more file")} at the root`,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            )}
            <h3 className="label-caps mt-1 text-muted-foreground">Recently changed</h3>
            <ul aria-label="Recently changed files" className="flex flex-col text-sm">
              {recent.map((file) => (
                <li key={file.id} className="relative isolate">
                  {arrived.has(file.id) && <ArrivalGlow key={arrived.get(file.id)!.at} mark={arrived.get(file.id)!} />}
                  <Link href={fileHref(file)} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-accent">
                    <CustodyMark kind={file.updatedBy.actorType} />
                    <span className="min-w-0 flex-1 truncate" title={file.path}>
                      {file.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground" title={formatAbsolute(file.updatedAt)}>
                      {formatRelative(file.updatedAt, now)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        );
      })()}
    </Panel>
  );
}

function ContextPanel({ workspaceId, resource, onRetry, retrying }: PanelProps<ContextDetails>) {
  return (
    <Panel id="overview-context" title="Project context" href={`/w/${workspaceId}/context`} linkLabel="Open context">
      {resource.status === "loading" && <Skeleton className="h-48" aria-label="Loading project context" />}
      {resource.status === "error" && <ErrorState error={resource.error} onRetry={onRetry} retrying={retrying} />}
      {resource.status === "ready" && (
        <>
          <p className="label-caps text-muted-foreground">Version {resource.data.version}</p>
          <dl className="flex flex-col gap-3 text-sm">
            {contextDigest(resource.data).map(({ field, label, entries }) => (
              <div key={field} className="flex flex-col gap-1">
                <dt className="flex items-baseline gap-2 font-semibold">
                  {label}
                  {field !== "goal" && field !== "scope" && (
                    <span className="text-xs font-normal text-muted-foreground">{entries.length}</span>
                  )}
                </dt>
                {entries.length === 0 ? (
                  <dd className="text-muted-foreground">None yet</dd>
                ) : (
                  <>
                    {entries.slice(0, DIGEST_ENTRIES).map((entry) => (
                      <dd key={entry.id} className="line-clamp-2 break-words">
                        {entry.text}
                      </dd>
                    ))}
                    {entries.length > DIGEST_ENTRIES && (
                      <dd className="text-xs text-muted-foreground">and {entries.length - DIGEST_ENTRIES} more</dd>
                    )}
                  </>
                )}
              </div>
            ))}
          </dl>
        </>
      )}
    </Panel>
  );
}
