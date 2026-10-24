"use client";

import type { ReactNode } from "react";
import { USE_MOCKS } from "@/lib/config";
import { useClearDraftsOnSignOutElsewhere } from "@/lib/auth/signOutAndLeave";
import { MockProviders } from "@/components/providers/MockProviders";
import { ConvexProviders } from "@/components/providers/ConvexProviders";

export function Providers({ children }: { children: ReactNode }) {
  useClearDraftsOnSignOutElsewhere();
  // USE_MOCKS is inlined at build time, so only one branch ever runs.
  if (USE_MOCKS) return <MockProviders>{children}</MockProviders>;
  return <ConvexProviders>{children}</ConvexProviders>;
}
