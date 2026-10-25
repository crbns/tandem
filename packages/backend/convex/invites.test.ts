/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const CODE_PATTERN = /^[A-HJ-NP-Z]{6}$/;

/** Resolves to the thrown ConvexError's data, or fails the test. */
async function errorData(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ConvexError) return err.data as Record<string, unknown>;
    const data = (err as { data?: unknown }).data;
    if (typeof data === "string") return JSON.parse(data);
    if (data && typeof data === "object") return data as Record<string, unknown>;
    throw err;
  }
  throw new Error("expected the call to throw");
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function setup() {
  const t = convexTest(schema, modules);
  const insertUser = (name: string) => t.run((ctx) => ctx.db.insert("users", { name }));
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session` });
  const alexId = await insertUser("Alex");
  const samId = await insertUser("Sam");
  const jordanId = await insertUser("Jordan");
  const alex = as(alexId);
  const sam = as(samId);
  const jordan = as(jordanId);
  const workspaceId = await alex.mutation(api.workspaces.createWorkspace, { name: "Demo" });
  const invite = () =>
    alex.mutation(api.workspaces.createWorkspaceInvite, { workspaceId, role: "member" });
  const members = () =>
    t.run((ctx) =>
      ctx.db.query("workspace_members")
        .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
  return { t, alex, alexId, sam, samId, jordan, workspaceId, invite, members };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace invite codes", () => {
  it("issues a 6-letter code and stores only its hash", async () => {
    const { t, invite } = await setup();
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const { inviteId, token } = await invite();
      expect(token).toMatch(CODE_PATTERN);
      codes.add(token);
      const stored = await t.run((ctx) => ctx.db.get(inviteId));
      expect(stored?.tokenHash).toBe(await sha256(token));
    }
    expect(codes.size).toBeGreaterThan(1);
  });

  it("accepts a lowercase code typed with spaces and dashes", async () => {
    const { sam, samId, workspaceId, invite, members } = await setup();
    const { token } = await invite();
    const typed = `  ${token.slice(0, 3).toLowerCase()} - ${token.slice(3).toLowerCase()} `;
    expect(await sam.mutation(api.workspaces.acceptWorkspaceInvite, { token: typed }))
      .toEqual({ workspaceId });
    expect((await members()).find((m) => m.userId === samId)?.role).toBe("member");
  });

  it("rejects malformed and unknown codes as INVITE_INVALID", async () => {
    const { sam, invite } = await setup();
    await invite();
    for (const token of ["", "ABCDE", "ABCDEFG", "ABCDE1", "ABCDEI", "ABCDEO", "a".repeat(64)]) {
      expect(await errorData(sam.mutation(api.workspaces.acceptWorkspaceInvite, { token })))
        .toMatchObject({ code: "INVITE_INVALID" });
    }
  });

  it("rejects a reused code as INVITE_USED", async () => {
    const { sam, jordan, invite } = await setup();
    const { token } = await invite();
    await sam.mutation(api.workspaces.acceptWorkspaceInvite, { token });
    expect(await errorData(jordan.mutation(api.workspaces.acceptWorkspaceInvite, { token })))
      .toMatchObject({ code: "INVITE_USED" });
  });

  it("reports revoked and expired codes", async () => {
    const { t, alex, sam, invite } = await setup();
    const revoked = await invite();
    await alex.mutation(api.workspaces.revokeWorkspaceInvite, { inviteId: revoked.inviteId });
    expect(await errorData(sam.mutation(api.workspaces.acceptWorkspaceInvite, { token: revoked.token })))
      .toMatchObject({ code: "INVITE_REVOKED" });
    const expired = await invite();
    await t.run((ctx) => ctx.db.patch(expired.inviteId, { expiresAt: Date.now() - 1 }));
    expect(await errorData(sam.mutation(api.workspaces.acceptWorkspaceInvite, { token: expired.token })))
      .toMatchObject({ code: "INVITE_EXPIRED" });
  });

  it("accepts the live invite when a consumed one shares its code", async () => {
    const { t, alexId, sam, samId, workspaceId, invite, members } = await setup();
    const { inviteId, token } = await invite();
    // An older, already-used invite in another workspace with the same code.
    const otherWorkspaceId = await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        name: "Old", createdBy: alexId, updatedBy: { type: "human", userId: alexId, label: "Alex" },
        revision: 1, createdAt: 0, updatedAt: 0,
      }),
    );
    // Inserted after the live row, so it is the newest match for the hash.
    await t.run(async (ctx) => {
      const live = await ctx.db.get(inviteId);
      if (!live) throw new Error("missing invite");
      await ctx.db.insert("workspace_invites", {
        workspaceId: otherWorkspaceId, tokenHash: live.tokenHash, role: "member",
        createdBy: alexId, createdAt: 0, expiresAt: live.expiresAt,
        acceptedBy: alexId, acceptedAt: 1, updatedBy: live.updatedBy, revision: 2, updatedAt: 1,
      });
    });
    expect(await sam.mutation(api.workspaces.acceptWorkspaceInvite, { token }))
      .toEqual({ workspaceId });
    expect((await members()).some((m) => m.userId === samId)).toBe(true);
  });

  it("regenerates a code that collides with a live invite", async () => {
    const { t, invite } = await setup();
    const first = await invite();
    // Feed the generator the first code's bytes once, then fall back to real randomness.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const replay = Array.from(first.token, (letter) => alphabet.indexOf(letter));
    const real = crypto.getRandomValues.bind(crypto);
    let replayed = false;
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      if (!replayed && array instanceof Uint8Array) {
        replayed = true;
        array.fill(0);
        array.set(replay);
        return array;
      }
      return real(array);
    });
    const second = await invite();
    expect(replayed).toBe(true);
    expect(second.token).toMatch(CODE_PATTERN);
    expect(second.token).not.toBe(first.token);
    const stored = await t.run((ctx) => ctx.db.get(second.inviteId));
    expect(stored?.tokenHash).toBe(await sha256(second.token));
  });
});
