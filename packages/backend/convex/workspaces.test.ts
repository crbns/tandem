/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("getWorkspaceInfo members", () => {
  it("names each member, falling back to email, then null", async () => {
    const t = convexTest(schema, modules);
    const insertUser = (fields: { name?: string; email?: string }) =>
      t.run((ctx) => ctx.db.insert("users", fields));
    const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session` });
    const owner = as(await insertUser({ name: "Alex", email: "alex@example.com" }));
    const workspaceId = await owner.mutation(api.workspaces.createWorkspace, { name: "Demo" });
    for (const fields of [{ email: "sam@example.com" }, {}]) {
      const { token } = await owner.mutation(api.workspaces.createWorkspaceInvite, {
        workspaceId,
        role: "member",
      });
      await as(await insertUser(fields)).mutation(api.workspaces.acceptWorkspaceInvite, { token });
    }
    const info = await owner.query(api.workspaces.getWorkspaceInfo, { workspaceId });
    expect(info.members.map((m) => [m.name, m.role])).toEqual([
      ["Alex", "owner"],
      ["sam@example.com", "member"],
      [null, "member"],
    ]);
  });
});
