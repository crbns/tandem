"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  BotIcon,
  BookOpenIcon,
  ChevronDownIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  StampIcon,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "@/lib/auth/useSession";
import { signOutAndLeave } from "@/lib/auth/signOutAndLeave";
import { countDraftStashes } from "@/lib/editor/draftStash";
import { USE_MOCKS } from "@/lib/config";
import { TandemMark } from "@/components/common/TandemMark";
import { CustodyMark } from "@/components/common/CustodyMark";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface AppShellProps {
  workspaceId: string;
  workspaceName: string;
  /** Files in the workspace; null while unknown. */
  fileCount?: number | null;
  children: ReactNode;
}

function crumbFor(pathname: string, filesHref: string): string {
  if (pathname.endsWith("/history")) return "History";
  if (pathname.startsWith(`${filesHref}/files/`)) return "File";
  if (pathname.startsWith(`${filesHref}/context`)) return "Project context";
  if (pathname.startsWith(`${filesHref}/approvals`)) return "Approvals";
  if (pathname.startsWith(`${filesHref}/assistants`)) return "Assistants";
  if (pathname.startsWith(`${filesHref}/overview`)) return "Overview";
  return "Files";
}

function NavItem({
  href,
  icon: Icon,
  label,
  active,
  current,
  children,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  current: boolean;
  children?: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
        active ? "bg-archive-tint text-archive" : "text-foreground hover:bg-accent",
      )}
    >
      <Icon className="size-4" />
      {label}
      {children}
    </Link>
  );
}

export function AppShell({ workspaceId, workspaceName, fileCount = null, children }: AppShellProps) {
  const { user, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const filesHref = `/w/${workspaceId}`;
  const onFiles = pathname === filesHref || pathname.startsWith(`${filesHref}/files`);
  // Signing out deletes this tab's unsaved drafts, so ask first when there are any.
  const [unsavedOnSignOut, setUnsavedOnSignOut] = useState(0);
  const leave = () => void signOutAndLeave(signOut, () => router.replace("/sign-in"));

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-58 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex items-center gap-2.5 px-4 pb-6 pt-5">
          <TandemMark />
          <div className="min-w-0">
            <div className="truncate text-[0.9375rem] font-semibold leading-5">{workspaceName}</div>
            <div className="text-xs text-muted-foreground">Tandem workspace</div>
          </div>
        </div>
        <nav aria-label="Workspace" className="flex flex-col gap-0.5 px-3">
          <NavItem
            href={`${filesHref}/overview`}
            icon={LayoutDashboardIcon}
            label="Overview"
            active={pathname.startsWith(`${filesHref}/overview`)}
            current={pathname === `${filesHref}/overview`}
          />
          <NavItem href={filesHref} icon={FileTextIcon} label="Files" active={onFiles} current={pathname === filesHref}>
            {fileCount !== null && (
              <span className="label-caps ml-auto font-normal text-muted-foreground">{fileCount}</span>
            )}
          </NavItem>
          <NavItem href={`${filesHref}/context`} icon={BookOpenIcon} label="Project context" active={pathname.startsWith(`${filesHref}/context`)} current={pathname === `${filesHref}/context`} />
          <NavItem
            href={`${filesHref}/approvals`}
            icon={StampIcon}
            label="Approvals"
            active={pathname.startsWith(`${filesHref}/approvals`)}
            current={pathname === `${filesHref}/approvals`}
          />
          <NavItem
            href={`${filesHref}/assistants`}
            icon={BotIcon}
            label="Assistants"
            active={pathname.startsWith(`${filesHref}/assistants`)}
            current={pathname === `${filesHref}/assistants`}
          />
        </nav>
        <div className="mt-auto border-t px-4 py-4 text-xs leading-[1.125rem] text-muted-foreground">
          <p className="mb-2 font-semibold text-foreground">Assistants</p>
          <p>
            Teammates&apos; assistants read and edit these files through Tandem. Their saves are recorded as{" "}
            <span className="inline-flex items-center gap-1 font-medium text-agent">
              <CustodyMark kind="agent" />
              Agent
            </span>
            ; yours as{" "}
            <span className="inline-flex items-center gap-1 font-medium text-human">
              <CustodyMark kind="human" />
              Human
            </span>
            .
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b bg-card px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <TandemMark className="size-6 md:hidden" />
            <Link href={filesHref} className="truncate text-muted-foreground hover:text-foreground">
              {workspaceName}
            </Link>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            <span className="font-semibold">{crumbFor(pathname, filesHref)}</span>
          </div>
          <div className="flex items-center gap-2">
            {USE_MOCKS && (
              <Badge variant="outline" className="label-caps border-dashed text-muted-foreground">
                Mock data
              </Badge>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Account menu for ${user?.name ?? "you"}`}>
                  <span
                    aria-hidden
                    className="flex size-6 items-center justify-center rounded-full bg-human text-xs font-semibold text-white"
                  >
                    {(user?.name ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden max-w-40 truncate sm:inline">{user?.name}</span>
                  <ChevronDownIcon className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="truncate text-sm font-medium">{user?.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {/* The rail is hidden on small screens; these keep its sections reachable. */}
                <DropdownMenuItem className="md:hidden" onSelect={() => router.push(`${filesHref}/overview`)}>
                  <LayoutDashboardIcon />
                  Overview
                </DropdownMenuItem>
                <DropdownMenuItem className="md:hidden" onSelect={() => router.push(`${filesHref}/context`)}>
                  <BookOpenIcon />
                  Project context
                </DropdownMenuItem>
                <DropdownMenuItem className="md:hidden" onSelect={() => router.push(`${filesHref}/approvals`)}>
                  <StampIcon />
                  Approvals
                </DropdownMenuItem>
                <DropdownMenuItem className="md:hidden" onSelect={() => router.push(`${filesHref}/assistants`)}>
                  <BotIcon />
                  Assistants
                </DropdownMenuItem>
                <DropdownMenuSeparator className="md:hidden" />
                <DropdownMenuItem
                  onSelect={() => {
                    const unsaved = countDraftStashes();
                    if (unsaved > 0) setUnsavedOnSignOut(unsaved);
                    else leave();
                  }}
                >
                  <LogOutIcon />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 px-4 py-7 md:px-8">{children}</main>
      </div>

      <Dialog open={unsavedOnSignOut > 0} onOpenChange={(open) => !open && setUnsavedOnSignOut(0)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out and discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have unsaved changes in {unsavedOnSignOut === 1 ? "1 file" : `${unsavedOnSignOut} files`}. Signing
              out deletes them from this browser. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnsavedOnSignOut(0)}>
              Stay signed in
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setUnsavedOnSignOut(0);
                leave();
              }}
            >
              Discard and sign out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
