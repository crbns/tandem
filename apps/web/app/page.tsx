"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/useSession";
import { DEFAULT_WORKSPACE_ID } from "@/lib/config";
import { FullPageSpinner } from "@/components/common/FullPageSpinner";

export default function Home() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/sign-in");
    if (status === "authenticated") router.replace(`/w/${DEFAULT_WORKSPACE_ID || "ws_demo"}`);
  }, [status, router]);

  return <FullPageSpinner />;
}
