import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { verifiedPrincipal } from "./authentication-fixture.js";
import { request } from "./authentication-http-fixture.js";

async function hostFixture() {
  const captured: {
    operator: string | string[] | undefined;
    body: JsonObject;
  }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === "/api/v1/device/approve") {
      captured.push({
        operator: req.headers["x-opensesame-operator"],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
    }
    res.writeHead(200);
    res.end("fixture-only");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture listener address");
  return {
    captured,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

it("injects the configured operator only into the actual loopback Host request and never in the browser response", async () => {
  const host = await hostFixture();
  try {
    const token = randomBytes(32).toString("hex");
    const plane = createControlPlane({
      processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        operatorToken: token,
        hostApiUrl: host.url,
        bootstrapPersonalOrganization: false,
      },
    });
    const owner = await verifiedPrincipal(plane.app);
    const org = await request(plane, "/v1/organizations", owner.auth, "POST", {
      slug: `fixture-${randomUUID()}`,
      displayName: "Fixture Workspace",
    });
    expect(org.status).toBe(201);
    const workspace: { id: string } = overlapCast(await org.json());
    const approved = await request(
      plane,
      "/v1/device/approve",
      owner.auth,
      "POST",
      { user_code: "ABCD-EFGH", organization_id: workspace.id },
    );
    expect(approved.status).toBe(200);
    const returned = await approved.text();
    expect(JSON.parse(returned)).toEqual({ ok: true, status: 200 });
    expect(returned).not.toContain(token);
    expect(returned).not.toContain("x-opensesame-operator");
    expect(host.captured).toHaveLength(1);
    expect(host.captured[0]).toEqual({
      operator: token,
      body: {
        user_code: "ABCD-EFGH",
        principal: owner.principalId,
        organization_id: workspace.id,
        organization_role: "owner",
      },
    });
    const rejected = await request(
      plane,
      "/v1/device/approve",
      owner.auth,
      "POST",
      { user_code: "ABCD-EFGH", organization_id: "foreign-organization" },
    );
    expect(rejected.status).toBe(403);
    expect(host.captured).toHaveLength(1);
  } finally {
    await host.close();
  }
});

it("explicitly unconfigured operator authority refuses without dispatching to the local Host fixture", async () => {
  const host = await hostFixture();
  try {
    const plane = createControlPlane({
      processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
      config: {
        operatorToken: "",
        hostApiUrl: host.url,
        bootstrapPersonalOrganization: false,
      },
    });
    const owner = await verifiedPrincipal(plane.app);
    const refused = await request(
      plane,
      "/v1/device/approve",
      owner.auth,
      "POST",
      { user_code: "ABCD-EFGH", organization_id: "fixture-org" },
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: "operator_token_unconfigured",
    });
    expect(host.captured).toHaveLength(0);
  } finally {
    await host.close();
  }
});
