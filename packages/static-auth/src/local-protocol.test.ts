import { describe, expect, it } from "vitest";
import {
  type LocalAuthorizationRequest,
  localAuthorizationQuery,
  localMessage,
  parseLocalAuthorizationRequest,
} from "./local-protocol.js";

const request: LocalAuthorizationRequest = {
  applicationId: "local_00000000-0000-4000-8000-000000000001",
  redirectUri: "https://rp.example.test/callback",
  scopes: ["openid"],
  state: "s".repeat(43),
  nonce: "n".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256",
};
describe("browser-local authorization wire boundary", () => {
  it("requires an exact complete agent binding and rejects duplicates", () => {
    const agent = { principalId: request.applicationId, keyId: "k".repeat(43) };
    const query = localAuthorizationQuery({ ...request, agent });
    expect(parseLocalAuthorizationRequest(query)).toEqual({
      ...request,
      agent,
    });
    for (const tail of [
      `&agent_id=${agent.principalId}`,
      `&agent_key_id=${agent.keyId}`,
    ])
      expect(() => parseLocalAuthorizationRequest(query + tail)).toThrow();
    const base = localAuthorizationQuery(request);
    for (const tail of [
      `&agent_id=${agent.principalId}`,
      `&agent_key_id=${agent.keyId}`,
      `&agent_id=unknown&agent_key_id=${agent.keyId}`,
      `&agent_id=${agent.principalId}&agent_key_id=short`,
    ])
      expect(() => parseLocalAuthorizationRequest(base + tail)).toThrow();
  });
  it("round-trips exact registrations without accepting response parameters", () => {
    const query = localAuthorizationQuery(request);
    expect(parseLocalAuthorizationRequest(query)).toEqual(request);
    for (const suffix of [
      "&state=duplicate",
      "&code=token",
      "&code_verifier=secret",
      "&other=x",
    ])
      expect(() => parseLocalAuthorizationRequest(query + suffix)).toThrow();
  });
  it.each([
    { redirectUri: "https://user:password@rp.example.test/callback" },
    { redirectUri: "https://rp.example.test/callback#token" },
    { redirectUri: "https://rp.example.test/callback#" },
    { redirectUri: "http://remote.example.test/callback" },
    { redirectUri: "https://RP.example.test/callback" },
    { redirectUri: "https://rp.example.test/*" },
    { scopes: ["openid", "openid"] },
    { scopes: ["resource:write"] },
    { scopes: ["openid", "x".repeat(65)] },
    { scopes: Array(33).fill("openid") },
    { state: "short" },
    { nonce: "short" },
    { codeChallenge: "short" },
  ])("refuses malformed or ambiguous request %j", (patch) => {
    expect(() =>
      parseLocalAuthorizationRequest(
        localAuthorizationQuery({ ...request, ...patch }),
      ),
    ).toThrow();
  });
  it("bounds query and channel messages before parsing/serializing nested data", () => {
    expect(() => parseLocalAuthorizationRequest("x".repeat(8193))).toThrow();
    expect(
      localMessage({ state: request.state, type: "ready" }, request.state),
    ).not.toBeNull();
    for (const value of [
      { state: "other", type: "ready" },
      { state: request.state, data: { nested: "x" } },
      { state: request.state, code: "x".repeat(2049) },
      { state: request.state, count: 1 },
    ])
      expect(localMessage(value, request.state)).toBeNull();
  });
});
