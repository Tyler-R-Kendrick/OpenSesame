import { name } from "@gdp-ts/core";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { actorId, projectId } from "../lib/ids.js";
import { projectAccess } from "../proofs/project-role.js";
import {
  deleteProject,
  grantMembership,
  leaveProject,
  revokeMembership,
  writeProject,
} from "../services/project-admin.js";
import { seedProject } from "./project-role-fixture.js";

function plane() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  }).ctx;
}

const MEMBERS = { own: "owner", adm: "admin", mem: "member" } as const;

describe("projectAccess verdicts", () => {
  it("earns exactly the proofs the role carries", async () => {
    const ctx = plane();
    await seedProject(ctx, "prj_roles", MEMBERS);
    const roles: string[] = [];
    for (const principal of ["own", "adm", "mem"]) {
      await name(
        actorId(principal),
        projectId("prj_roles"),
        async (actor, project) => {
          const verdict = await projectAccess(ctx, actor, project);
          if (!verdict.ok) throw new Error("expected access");
          roles.push(
            `${verdict.role}:${"admin" in verdict}:${"owner" in verdict}`,
          );
        },
      );
    }
    expect(roles).toEqual([
      "owner:true:true",
      "admin:true:false",
      "member:false:false",
    ]);
  });

  it("answers 404 for a stranger, a deleted project and an expired one", async () => {
    const ctx = plane();
    await seedProject(ctx, "prj_live", MEMBERS);
    await seedProject(ctx, "prj_gone", MEMBERS, { state: "deleted" });
    await seedProject(ctx, "prj_old", MEMBERS, {
      state: "provisional",
      expiresAt: new Date(ctx.clock().getTime() - 1000),
    });
    const cases = [
      ["stranger", "prj_live"],
      ["own", "prj_gone"],
      ["own", "prj_old"],
      ["own", "prj_missing"],
    ] as const;
    for (const [principal, id] of cases) {
      await name(actorId(principal), projectId(id), async (actor, project) => {
        const verdict = await projectAccess(ctx, actor, project);
        expect(verdict).toEqual({ ok: false, status: 404, error: "not_found" });
      });
    }
  });

  it("resolves the creator of a temporary project as owner without a membership", async () => {
    const ctx = plane();
    await seedProject(
      ctx,
      "prj_tmp",
      {},
      { kind: "temporary", ownerPrincipalId: "own" },
    );
    await name(actorId("own"), projectId("prj_tmp"), async (actor, project) => {
      const verdict = await projectAccess(ctx, actor, project);
      expect(verdict.ok && verdict.role).toBe("owner");
    });
  });
});

describe("guarded project mutations", () => {
  it("writes, grants, revokes and leaves under the matching proof", async () => {
    const ctx = plane();
    const row = await seedProject(ctx, "prj_w", MEMBERS);
    await name(actorId("own"), projectId("prj_w"), async (actor, project) => {
      const verdict = await projectAccess(ctx, actor, project);
      if (!verdict.ok || verdict.role !== "owner") throw new Error("owner");
      await writeProject(ctx, project, verdict.admin, {
        ...row,
        displayName: "renamed",
      });
      expect((await ctx.stores.projects.get("prj_w"))?.displayName).toBe(
        "renamed",
      );
      const now = ctx.clock();
      await grantMembership(ctx, project, verdict.admin, {
        projectId: "prj_w",
        principalId: "new",
        role: "member",
        createdAt: now,
        updatedAt: now,
      });
      ctx.stores.activeProjects.set("new", "prj_w");
      await revokeMembership(ctx, project, verdict.admin, "new");
      expect(
        await ctx.stores.projectMemberships.find("prj_w", "new"),
      ).toBeUndefined();
      expect(ctx.stores.activeProjects.get("new")).toBeUndefined();
      await deleteProject(ctx, project, verdict.owner, row);
      expect((await ctx.stores.projects.get("prj_w"))?.state).toBe("deleted");
      expect(
        await ctx.stores.projectMemberships.listByProject("prj_w"),
      ).toEqual([]);
    });
  });

  it("lets a plain member leave, but only as themselves", async () => {
    const ctx = plane();
    await seedProject(ctx, "prj_l", MEMBERS);
    await name(actorId("mem"), projectId("prj_l"), async (actor, project) => {
      const verdict = await projectAccess(ctx, actor, project);
      if (!verdict.ok) throw new Error("member");
      await leaveProject(ctx, actor, project, verdict.member);
      expect(
        await ctx.stores.projectMemberships.find("prj_l", "mem"),
      ).toBeUndefined();
      expect(
        await ctx.stores.projectMemberships.find("prj_l", "adm"),
      ).toBeDefined();
    });
  });

  it("refuses an admin proof that would rewrite an owner, and a row of another project", async () => {
    const ctx = plane();
    const row = await seedProject(ctx, "prj_g", MEMBERS);
    const other = await seedProject(ctx, "prj_h", MEMBERS);
    await name(actorId("adm"), projectId("prj_g"), async (actor, project) => {
      const verdict = await projectAccess(ctx, actor, project);
      if (!verdict.ok || verdict.role !== "admin") throw new Error("admin");
      const now = ctx.clock();
      await expect(
        grantMembership(ctx, project, verdict.admin, {
          projectId: "prj_g",
          principalId: "own",
          role: "member",
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow("only an owner");
      await expect(
        revokeMembership(ctx, project, verdict.admin, "own"),
      ).rejects.toThrow("only an owner");
      await expect(
        writeProject(ctx, project, verdict.admin, other),
      ).rejects.toThrow("different project");
      expect(
        await ctx.stores.projectMemberships.find("prj_g", "own"),
      ).toBeDefined();
      expect((await ctx.stores.projects.get("prj_g"))?.displayName).toBe(
        row.displayName,
      );
    });
  });
});
