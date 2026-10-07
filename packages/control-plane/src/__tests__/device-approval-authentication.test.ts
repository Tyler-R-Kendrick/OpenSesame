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

interface DeviceApprovalHeaders {
  origin?: string;
}

async function provisional(app: ReturnType<typeof createControlPlane>["app"]) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

it("does not let an ambient cookie approve a device from another origin", async () => {
  const { app, config } = createControlPlane({
    config: {
      operatorToken: randomBytes(32).toString("hex"),
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      corsOrigins: ["https://console.example"],
      bootstrapPersonalOrganization: false,
    },
  });
  const created = await provisional(app);
  const cookie = `${config.provisionalCookieName}=${created.accessToken}`;
  const approve = (headers: DeviceApprovalHeaders) =>
    app.request("/v1/device/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", ...headers },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });

  // A cookie arrives whether or not the page meant to send it.
  expect((await approve({})).status).toBe(401);
  expect((await approve({ origin: "https://evil.example" })).status).toBe(401);
  // An origin this deployment listed, or its own, is a caller it expects.
  expect((await approve({ origin: "https://console.example" })).status).toBe(
    400,
  );
  expect((await approve({ origin: "http://127.0.0.1:8788" })).status).toBe(400);
  // Reads are untouched: a forged read is not a forged write.
  const read = await app.request("/v1/audit/events", {
    headers: { cookie, origin: "https://evil.example" },
  });
  expect(read.status).toBe(200);
});
