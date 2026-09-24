import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedControlPlane } from "../../server.js";
import { type DisposablePki, type Issued, createDisposablePki } from "./pki.js";
import { bootWithTls, shutdown } from "./server-helpers.js";
import { tlsRequest } from "./tls-client.js";

/**
 * A browser-managed certificate is ambient authentication (AT-BROWSER-EXTERNAL):
 * it authenticates the connection, never the person. Origin/CSRF and CORS
 * controls apply unchanged on the certificate-authenticated listener.
 */
describe("browser boundary on the TLS listener", () => {
  let pki: DisposablePki;
  let server: Issued;
  let browser: Issued;
  let started: StartedControlPlane & { tlsPort: number };
  const allowed = "http://127.0.0.1:5180";
  beforeAll(async () => {
    pki = createDisposablePki();
    server = pki.issueServer("identity");
    browser = pki.issueClient("browser-device", { dns: ["device-7.example"] });
    started = await bootWithTls({ pki, server, policy: "mtls_required" });
  });
  afterAll(async () => {
    await shutdown(started);
    pki.cleanup();
  });

  async function provisionalCookie(): Promise<string> {
    const res = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: browser,
      method: "POST",
      path: "/v1/principals/provisional",
    });
    expect(res.status).toBe(201);
    const raw = res.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
    if (!cookie) throw new Error("no provisional cookie");
    return cookie;
  }

  it("a certificate does not sign anyone in: user routes still need a session", async () => {
    const res = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: browser,
      path: "/v1/principals/me",
    });
    expect(res.status).toBe(401);
  });

  it("a cookie-authenticated mutation with a cross-site Origin is refused (AT-BROWSER-CSRF)", async () => {
    const cookie = await provisionalCookie();
    const crossSite = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: browser,
      method: "POST",
      path: "/v1/principals/provisional/revoke",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    const noOrigin = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: browser,
      method: "POST",
      path: "/v1/principals/provisional/revoke",
      headers: { cookie },
    });
    expect(noOrigin.status).toBe(403);
    const sameSite = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: browser,
      method: "POST",
      path: "/v1/principals/provisional/revoke",
      headers: { cookie, origin: allowed },
    });
    expect(sameSite.status).toBe(204);
  });

  it("CORS stays exact-origin: no wildcard, unlisted origins get nothing (AT-BROWSER-CORS)", async () => {
    const preflight = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: browser,
      method: "OPTIONS",
      path: "/token",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    const api = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: browser,
      path: "/v1/health/live",
      headers: { origin: "https://evil.example" },
    });
    expect(api.headers["access-control-allow-origin"]).toBeUndefined();
    const listed = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: browser,
      path: "/v1/health/live",
      headers: { origin: allowed },
    });
    expect(listed.headers["access-control-allow-origin"]).toBe(allowed);
    expect(listed.headers["access-control-allow-origin"]).not.toBe("*");
  });
});
