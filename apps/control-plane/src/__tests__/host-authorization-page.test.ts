import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { hostAuthorizationAudiences } from "../services/host-authorization.js";

it("refuses an IP-literal Identity RP ID before serving Host authorization", () => {
  expect(() =>
    hostAuthorizationAudiences(
      { OPENSESAME_HOST_AUTHORIZATION_AUDIENCES: "http://127.0.0.1:8787" },
      false,
      "http://127.0.0.1:8788",
    ),
  ).toThrow(/Identity hostname/);
  expect(() =>
    hostAuthorizationAudiences(
      { OPENSESAME_HOST_AUTHORIZATION_AUDIENCES: "http://127.0.0.1:8787" },
      false,
      "http://[::1]:8788",
    ),
  ).toThrow(/Identity hostname/);
});

it("serves a non-framable ceremony only to an explicitly configured exact origin", async () => {
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ format: "jwk" });
  const plane = createControlPlane({
    config: {
      corsOrigins: ["https://pages.example"],
      publicUrl: "http://localhost:8788",
    },
    processEnv: {
      ...process.env,
      OPENSESAME_HOST_AUTHORIZATION_AUDIENCES: "http://127.0.0.1:8787",
      OPENSESAME_JWKS_JSON: JSON.stringify({
        keys: [{ ...key, alg: "RS256", kid: "page-test", use: "sig" }],
      }),
    },
  });
  const endpoint = (origin: string, state = "s".repeat(43)) =>
    `/v1/host-authorizations/ceremony?origin=${encodeURIComponent(origin)}&state=${state}`;
  for (const origin of [
    "https://attacker.example",
    "https://pages.example.attacker.invalid",
    "null",
    "*",
  ])
    expect((await plane.app.request(endpoint(origin))).status).toBe(403);
  expect(
    (await plane.app.request(endpoint("https://pages.example", "short")))
      .status,
  ).toBe(403);
  const response = await plane.app.request(endpoint("https://pages.example"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(response.headers.get("content-security-policy")).not.toContain(
    "unsafe-inline",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("Verify with passkey");
  const options = await plane.app.request("/v1/host-authorizations/options", {
    method: "POST",
    body: "{}",
  });
  expect(options.status).toBe(401);
  const script = await plane.app.request("/v1/host-authorizations/ceremony.js");
  expect(script.headers.get("content-type")).toContain("text/javascript");
});
