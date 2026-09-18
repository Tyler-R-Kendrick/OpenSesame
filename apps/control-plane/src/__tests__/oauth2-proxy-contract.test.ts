import { isString, overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";

type Started = Awaited<ReturnType<typeof startServer>>;

describe("OAuth2 Proxy OIDC consumer contract", () => {
  let started: Started;
  let base: string;

  beforeAll(async () => {
    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      started.server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("advertises the OIDC fields OAuth2 Proxy v7.8.2 needs (not a native proxy)", async () => {
    const res = await fetch(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const discovery = overlapCast(await res.json());
    for (const key of [
      "issuer",
      "authorization_endpoint",
      "token_endpoint",
      "jwks_uri",
      "userinfo_endpoint",
    ]) {
      expect(isString(discovery[key]) && discovery[key].length > 0).toBe(true);
    }
    expect(discovery.issuer).toBe(base);
    expect(String(discovery.token_endpoint)).toContain("/token");
    expect(discovery.code_challenge_methods_supported).toContain("S256");
  }, 30_000);
});
