import { expect, it } from "vitest";
import {
  importTailscaleAppResponse,
  tailscaleKeyHandoff,
  tailscaleRegistrationArtifact,
  tailscaleRegistrationRequest,
} from "./artifacts.js";
import { tailscaleAppName } from "./oauth-app.js";
const config = {
  apiBase: "https://api.tailscale.com/",
  tailnet: "-",
  redirectUri: "https://operator.example/callback",
  name: tailscaleAppName(),
};
const response = {
  id: "vendor-issued-id",
  name: config.name,
  clientSecret: "returned-fixture-secret",
  redirectURIs: [config.redirectUri],
  scopes: ["auth_keys:create:once"],
};
it("generates exact public registration payload and keeps the deployment identifier distinct from Tailscale's issued client id", () => {
  const artifact = JSON.parse(tailscaleRegistrationArtifact(config));
  expect(artifact).toMatchObject({
    format: "opensesame.tailscale-registration",
    version: 1,
    method: "POST",
    path: "/api/v2/tailnet/-/oauth-apps",
    request: tailscaleRegistrationRequest(config),
  });
  expect(artifact.deploymentId).toBeTruthy();
  expect(artifact.deploymentId).not.toBe(response.id);
  expect(Object.keys(artifact.request).sort()).toEqual([
    "name",
    "redirectUris",
    "scopes",
  ]);
  expect(tailscaleRegistrationArtifact(config)).not.toContain("clientSecret");
});
it("imports a vendor app response only with this deployment's callback and restricted scope", () => {
  expect(importTailscaleAppResponse(JSON.stringify(response), config)).toEqual(
    response,
  );
  expect(() =>
    importTailscaleAppResponse(
      JSON.stringify({
        ...response,
        redirectURIs: ["https://other.example/callback"],
      }),
      config,
    ),
  ).toThrow();
  expect(() =>
    importTailscaleAppResponse(
      JSON.stringify({ ...response, scopes: ["all"] }),
      config,
    ),
  ).toThrow();
  expect(() => importTailscaleAppResponse(" ".repeat(65537), config)).toThrow();
});
it("manual auth-key handoff keeps validity, lifetime and reuse unknown rather than inventing provider assurance", () => {
  expect(tailscaleKeyHandoff("  user-issued-opaque-key  ")).toEqual({
    key: "user-issued-opaque-key",
    expiresAt: null,
    singleUse: null,
  });
  for (const invalid of ["", "two keys", "line\nbreak", "x".repeat(16385)])
    expect(() => tailscaleKeyHandoff(invalid)).toThrow();
});
it("binds only declared custom node attributes to registration and returned credentials", () => {
  const attributes = ["custom:openss-deployment", "custom:operator"];
  const bound = { ...config, allowedNodeAttributes: attributes };
  expect(tailscaleRegistrationRequest(bound)).toHaveProperty(
    "allowedNodeAttributes",
    attributes,
  );
  expect(
    importTailscaleAppResponse(
      JSON.stringify({
        ...response,
        allowedNodeAttributes: [...attributes].reverse(),
      }),
      bound,
    ).allowedNodeAttributes,
  ).toEqual([...attributes].reverse());
  for (const attrs of [
    [],
    ["custom:operator"],
    ["tag:admin"],
    ["custom:operator", "custom:operator"],
  ]) {
    expect(() =>
      importTailscaleAppResponse(
        JSON.stringify({ ...response, allowedNodeAttributes: attrs }),
        bound,
      ),
    ).toThrow();
  }
  expect(() =>
    importTailscaleAppResponse(
      JSON.stringify({ ...response, allowedNodeAttributes: attributes }),
      config,
    ),
  ).toThrow();
});
