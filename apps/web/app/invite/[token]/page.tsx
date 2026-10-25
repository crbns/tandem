"use client";

import { useParams } from "next/navigation";
import { normalizeInviteCode } from "@/lib/inviteCode";
import { InviteCodeScreen } from "../InviteCodeScreen";

export default function InviteLinkPage() {
  const { token } = useParams<{ token: string }>();
  // Links and hand-typed URLs may say "abc-def" or "ABC%20DEF"; the form wants "ABCDEF".
  return <InviteCodeScreen initialCode={normalizeInviteCode(safeDecode(token))} />;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
