"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { ChevronDownIcon, FileTextIcon, LogOutIcon } from "lucide-react";
import { useSession } from "@/lib/auth/useSession";
import { signOutAndLeave } from "@/lib/auth/signOutAndLeave";
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
import { cn } from "@/lib/utils";

interface AppShellProps {
  workspaceId: string;
  workspaceName: string;
  children: ReactNode;
}

function crumbFor(pathname: string, filesHref: string): string {
  if (pathname.endsWith("/history")) return "History";
  if (pathname.startsWith(`${filesHref}/files/`)) return "File";
  return "Files";
}

export function AppShell({ workspaceId, workspaceName, children }: AppShellProps) {
  const { user, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const filesHref = `/w/${workspaceId}`;
  const onFiles = pathname === filesHref || pathname.startsWith(`${filesHref}/files`);

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
          <Link
            href={filesHref}
            aria-current={pathname === filesHref ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
              onFiles ? "bg-archive-tint text-archive" : "text-foreground hover:bg-accent",
            )}
          >
            <FileTextIcon className="size-4" />
            Files
          </Link>
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
                <DropdownMenuItem
                  onSelect={() => void signOutAndLeave(signOut, () => router.replace("/sign-in"))}
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
    </div>
  );
}
