import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { createMockApi, MOCK_WORKSPACE_ID, type MockTandemApi } from "@/lib/api/mock";
import { normalizeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/api/types";

const owner: Actor = { actorType: "human", userId: "owner" };
const teammate: Actor = { actorType: "human", userId: "teammate" };

describe("workspace invites", () => {
  let actor: Actor;
  let api: MockTandemApi;
  beforeEach(() => {
    actor = owner;
    api = createMockApi({ latencyMs: [0, 0], getActor: () => actor });
  });
  afterEach(() => vi.useRealTimers());

  it("joins once with the invited role and never exposes a token in listings", async () => {
    const invite = await api.createInvite(MOCK_WORKSPACE_ID, "admin");
    expect(invite.token).toMatch(/^[A-HJ-NP-Z]{6}$/);
    const listed = await api.listInvites(MOCK_WORKSPACE_ID);
    expect(listed[0]).not.toHaveProperty("token");
    expect(listed[0]).not.toHaveProperty("tokenHash");
    actor = teammate;
    await expect(api.acceptInvite(invite.token)).resolves.toEqual({ workspaceId: MOCK_WORKSPACE_ID });
    expect((await api.listWorkspaces())[0]?.role).toBe("admin");
    await expect(api.acceptInvite(invite.token)).rejects.toMatchObject({ code: "INVITE_USED" });
    actor = owner;
    expect((await api.listInvites(MOCK_WORKSPACE_ID))[0]?.acceptedBy).toBe(teammate.userId);
  });

  it("notifies workspace watchers when someone joins, and lists them with their role", async () => {
    const { token } = await api.createInvite(MOCK_WORKSPACE_ID, "member");
    let changes = 0;
    api.watchWorkspace(MOCK_WORKSPACE_ID, () => changes++);
    actor = teammate;
    await api.acceptInvite(token);
    await Promise.resolve();
    expect(changes).toBe(1);
    expect(await api.listWorkspaceMembers(MOCK_WORKSPACE_ID)).toContainEqual(
      expect.objectContaining({ userId: teammate.userId, role: "member" }),
    );
  });

  it("accepts a code typed in lowercase or with dashes and spaces", async () => {
    const lower = await api.createInvite(MOCK_WORKSPACE_ID, "member");
    const dashed = await api.createInvite(MOCK_WORKSPACE_ID, "member");
    actor = teammate;
    await expect(api.acceptInvite(lower.token.toLowerCase())).resolves.toEqual({ workspaceId: MOCK_WORKSPACE_ID });
    actor = { actorType: "human", userId: "third" };
    const typed = ` ${dashed.token.slice(0, 3).toLowerCase()}-${dashed.token.slice(3)} `;
    await expect(api.acceptInvite(typed)).resolves.toEqual({ workspaceId: MOCK_WORKSPACE_ID });
    actor = owner;
    const listed = await api.listInvites(MOCK_WORKSPACE_ID);
    expect(listed.map((i) => i.acceptedBy).sort()).toEqual(["teammate", "third"]);
  });

  it("does not consume a valid link when an existing member opens it", async () => {
    const { token } = await api.createInvite(MOCK_WORKSPACE_ID, "member");
    await api.acceptInvite(token);
    expect((await api.listInvites(MOCK_WORKSPACE_ID))[0]?.acceptedAt).toBeUndefined();
    actor = teammate;
    await api.acceptInvite(token);
    await expect(api.createInvite(MOCK_WORKSPACE_ID, "member")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.listInvites(MOCK_WORKSPACE_ID)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects invalid, revoked, expired and signed-out acceptance", async () => {
    const revoked = await api.createInvite(MOCK_WORKSPACE_ID, "member");
    await api.revokeInvite(revoked.inviteId);
    await api.revokeInvite(revoked.inviteId);
    const expiring = await api.createInvite(MOCK_WORKSPACE_ID, "member");
    actor = teammate;
    await expect(api.acceptInvite("wrong")).rejects.toMatchObject({ code: "INVITE_INVALID" });
    await expect(api.acceptInvite(revoked.token)).rejects.toMatchObject({ code: "INVITE_REVOKED" });
    vi.useFakeTimers();
    vi.setSystemTime(expiring.expiresAt);
    await expect(api.acceptInvite(expiring.token)).rejects.toMatchObject({ code: "INVITE_EXPIRED" });
    actor = { actorType: "human", userId: "user_anonymous" };
    await expect(api.acceptInvite(expiring.token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("enforces invite-workspace permissions on revoke and rejects owner invites", async () => {
    const invite = await api.createInvite(MOCK_WORKSPACE_ID, "member");
    actor = teammate;
    await expect(api.revokeInvite(invite.inviteId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    actor = owner;
    // Even an untyped caller must not create an owner invite.
    // @ts-expect-error owner is deliberately outside the invitation contract
    await expect(api.createInvite(MOCK_WORKSPACE_ID, "owner")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each(["INVITE_INVALID", "INVITE_EXPIRED", "INVITE_USED", "INVITE_REVOKED"] as const)("maps backend %s errors", (code) => {
    expect(normalizeError(new ConvexError({ code })).code).toBe(code);
  });
});
