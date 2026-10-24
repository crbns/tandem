"use client";

import { useEffect, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/useSession";
import { AppShell } from "@/components/shell/AppShell";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  // The proxy guards /w/* server-side in real mode; this also covers mock mode
  // and a session that expires while the tab is open.
  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, pathname, router]);

  if (status !== "authenticated") return <FullPageSpinner />;

  return (
    <AppShell workspaceId={workspaceId} workspaceName="Workspace">
      {children}
    </AppShell>
  );
}
