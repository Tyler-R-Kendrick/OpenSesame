import { randomBytes } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

it("device approve requires authentication and never exposes operator token", async () => {
  const operatorToken = randomBytes(32).toString("hex");
  const { app, config } = createControlPlane({
    config: {
      operatorToken,
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      // Keep bootstrapPersonalOrganization: false so device approve hits
      // organization_id_required and quota tests are not pre-consumed.
      bootstrapPersonalOrganization: false,
    },
  });
  expect(config.operatorToken).toBeTruthy();
  const unauth = await app.request("/v1/device/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_code: "ABCD-EFGH" }),
  });
  expect(unauth.status).toBe(401);
  const principal = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(principal.status).toBe(201);
  const created = overlapCast(await principal.json());
  const auth = { authorization: `Bearer ${created.accessToken}` };
  const res = await app.request("/v1/device/approve", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ user_code: "ABCD-EFGH" }),
  });
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).not.toContain(config.operatorToken);
  expect(body.toLowerCase()).not.toContain("x-opensesame-operator");
});
