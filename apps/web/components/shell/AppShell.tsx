"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { BotIcon, ChevronDownIcon, FileTextIcon, LogOutIcon } from "lucide-react";
import { useSession } from "@/lib/auth/useSession";
import { signOutAndLeave } from "@/lib/auth/signOutAndLeave";
import { USE_MOCKS } from "@/lib/config";
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

export function AppShell({ workspaceId, workspaceName, children }: AppShellProps) {
  const { user, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const filesHref = `/w/${workspaceId}`;
  const onFiles = pathname === filesHref || pathname.startsWith(`${filesHref}/files`);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            T
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{workspaceName}</div>
            <div className="text-xs text-muted-foreground">Tandem workspace</div>
          </div>
        </div>
        <nav aria-label="Workspace" className="flex flex-col gap-0.5 p-2">
          <Link
            href={filesHref}
            aria-current={pathname === filesHref ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              onFiles ? "bg-accent font-medium" : "hover:bg-accent/60",
            )}
          >
            <FileTextIcon className="size-4" />
            Files
          </Link>
        </nav>
        <div className="mt-auto border-t p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
            <BotIcon className="size-3.5" />
            Assistants
          </p>
          Teammates&apos; assistants (Claude, ChatGPT, Gemini) read and edit these files through Tandem&apos;s MCP
          server. Their saves show up here marked <span className="font-medium">Agent</span>.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b px-4 md:px-6">
          <Link href={filesHref} className="truncate text-sm font-semibold md:hidden">
            {workspaceName}
          </Link>
          <div className="hidden min-w-0 md:block">
            <span className="truncate text-sm font-medium">{workspaceName}</span>
            <span className="ml-2 text-xs text-muted-foreground">Shared files · assistants edit through MCP</span>
          </div>
          <div className="flex items-center gap-2">
            {USE_MOCKS && <Badge variant="outline">Mock data</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Account menu for ${user?.name ?? "you"}`}>
                  <span
                    aria-hidden
                    className="flex size-6 items-center justify-center rounded-full bg-secondary text-xs font-medium"
                  >
                    {(user?.name ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="max-w-40 truncate">{user?.name}</span>
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
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
