import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { verifyAuditChain } from "@opensesame/audit";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { reserveLegacyAgent } from "../repos/legacy-agent-store.js";
import { getAgentUsage } from "../state.js";

it("persists registered actors and their claims across app instances, with a single quota winner", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: new URL(
        "../../../../packages/database/drizzle",
        import.meta.url,
      ).pathname,
    });
    const processEnv = {
      ...process.env,
      OPENSESAME_CLAIM_PEPPER: randomBytes(32).toString("base64url"),
    };
    const open = async () => {
      const plane = createControlPlane({
        database: overlapCast(db),
        processEnv,
      });
      await plane.ctx.systemPrincipalReady;
      return plane;
    };
    const first = await open();
    const ownerResponse = await first.app.request(
      "/v1/principals/provisional",
      { method: "POST" },
    );
    expect(ownerResponse.status).toBe(201);
    const owner = overlapCast(await ownerResponse.json());
    const headers = {
      authorization: `Bearer ${owner.accessToken}`,
      "content-type": "application/json",
    };
    const register = (plane: typeof first, name: string) =>
      plane.app.request("/v1/agents", {
        method: "POST",
        headers,
        body: JSON.stringify({
          displayName: name,
          publicKeyJkt: `jkt-${name}`,
        }),
      });
    const registered = await register(first, "durable");
    expect(registered.status).toBe(201);
    const agent = overlapCast(await registered.json());

    const second = await open();
    expect((await second.ctx.stores.agents.get(agent.agentId))?.state).toBe(
      "provisional",
    );
    expect(
      (await second.ctx.stores.agentInstances.get(agent.instanceId))
        ?.publicKeyJkt,
    ).toBe("jkt-durable");
    expect(await getAgentUsage(second.ctx.stores, owner.principalId)).toBe(1);
    const persistedAgent = await second.ctx.stores.agents.get(agent.agentId);
    const persistedInstance = await second.ctx.stores.agentInstances.get(
      agent.instanceId,
    );
    if (!persistedAgent || !persistedInstance)
      throw new Error("Registration missing");
    // A duplicate proof key fails the second insert; the first insert must roll back.
    await expect(
      reserveLegacyAgent(
        second.ctx.stores,
        { ...persistedAgent, id: "agt_rollback" },
        { ...persistedInstance, id: "agi_rollback", agentId: "agt_rollback" },
        () => true,
      ),
    ).rejects.toThrow();
    expect(await second.ctx.stores.agents.get("agt_rollback")).toBeUndefined();
    expect(
      await second.ctx.stores.agentInstances.get("agi_rollback"),
    ).toBeUndefined();
    await second.app.request("/v1/claims/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: agent.claimToken }),
    });
    const completed = await second.app.request(
      `/v1/claims/${agent.claimId}/complete`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ acceptedItemIds: [], userCode: agent.userCode }),
      },
    );
    expect(completed.status).toBe(200);
    expect((await first.ctx.stores.agents.get(agent.agentId))?.state).toBe(
      "claimed",
    );

    const responses = await Promise.all([
      register(first, "race-one"),
      register(second, "race-two"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 403,
    ]);
    const restarted = await open();
    expect(await getAgentUsage(restarted.ctx.stores, owner.principalId)).toBe(
      2,
    );
    expect(await restarted.ctx.stores.agentInstances.size).toBe(2);
    const claimed = await restarted.app.request(
      `/v1/agents/${agent.agentId}/claim`,
      { method: "POST", headers },
    );
    expect(claimed.status).toBe(201);
    const trail = await restarted.ctx.repos.auditEvents.list({ limit: 1000 });
    expect(verifyAuditChain([...trail].reverse()).ok).toBe(true);
  } finally {
    await client.close();
  }
});
