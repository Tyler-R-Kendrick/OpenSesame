import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Database, oidcPayloads } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { isString, overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { createControlPlaneClient } from "../../../sdk-cli/src/control-plane.js";
import { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";

it("isolates public SDK sessions and claim credentials on a durable live Identity API", async () => {
  const client = new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/database/drizzle",
    ),
  });
  const database: Database = overlapCast(db);
  const secret = randomBytes(32).toString("base64url");
  const started = await onFreePort((port) =>
    startServer({
      database,
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
        claimPepper: secret,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_CLAIM_PEPPER: secret,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
      },
    }),
  );
  try {
    const baseUrl = `http://127.0.0.1:${started.port}`;
    const customerA = createControlPlaneClient({ baseUrl });
    const customerB = createControlPlaneClient({ baseUrl });
    const sessionA = await customerA.createProvisionalSession();
    const sessionB = await customerB.createProvisionalSession();
    expect(sessionA.accessToken).not.toBe(sessionB.accessToken);
    expect(sessionA.principalId).not.toBe(sessionB.principalId);
    expect(await customerA.whoami()).toMatchObject({
      id: sessionA.principalId,
    });
    expect(await customerB.whoami()).toMatchObject({
      id: sessionB.principalId,
    });
    const agentA = await customerA.registerAnonymousAgent({
      displayName: "customer-a agent",
      publicKeyJkt: randomBytes(32).toString("base64url"),
    });
    const agentB = await customerB.registerAnonymousAgent({
      displayName: "customer-b agent",
      publicKeyJkt: randomBytes(32).toString("base64url"),
    });
    if (
      !isString(agentA.claimId) ||
      !isString(agentA.claimToken) ||
      !isString(agentB.claimId) ||
      !isString(agentB.claimToken)
    )
      throw new Error("missing claim credentials");
    expect(
      await customerA.pollClaim(agentA.claimId, agentA.claimToken),
    ).toMatchObject({ id: agentA.claimId, state: "pending" });
    expect(
      await customerB.pollClaim(agentB.claimId, agentB.claimToken),
    ).toMatchObject({ id: agentB.claimId, state: "pending" });
    await expect(
      customerA.pollClaim(agentB.claimId, agentA.claimToken),
    ).rejects.toThrow("claim poll failed:");
    await expect(
      customerB.pollClaim(agentA.claimId, agentB.claimToken),
    ).rejects.toThrow("claim poll failed:");
    const dump = JSON.stringify(await db.select().from(oidcPayloads));
    expect(dump).not.toContain(sessionA.accessToken);
    expect(dump).not.toContain(sessionB.accessToken);
    expect(dump).not.toContain(agentA.claimToken);
    expect(dump).not.toContain(agentB.claimToken);
    expect(dump).toContain("osev2.");
  } finally {
    started.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      started.server.close((error) => (error ? reject(error) : resolve())),
    );
    await client.close();
  }
}, 60_000);
