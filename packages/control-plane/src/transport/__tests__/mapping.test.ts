import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedControlPlane } from "../../server.js";
import {
  type DisposablePki,
  type Issued,
  createDisposablePki,
  writeBindings,
} from "./pki.js";
import { bootWithTls, mappingBindings, shutdown } from "./server-helpers.js";
import { tlsRequest } from "./tls-client.js";

const RESOLVE =
  "/v1/principals/mapping/resolve?issuer=https%3A%2F%2Fidp.example&subject=alice";

describe("mapping resolve receiver (ID-MAPPING)", () => {
  let pki: DisposablePki;
  let server: Issued;
  let host: Issued;
  let otherService: Issued;
  let bindingsFile: string;
  beforeAll(() => {
    pki = createDisposablePki();
    server = pki.issueServer("identity");
    host = pki.issueClient("host", { dns: ["host.mapping.example"] });
    otherService = pki.issueClient("worker", { dns: ["worker.example"] });
    bindingsFile = writeBindings(pki, mappingBindings("host.mapping.example"));
  });
  afterAll(() => pki.cleanup());

  describe("OPENSESAME_MAPPING_AUTH=mtls", () => {
    let started: StartedControlPlane & { tlsPort: number };
    beforeAll(async () => {
      started = await bootWithTls({
        pki,
        server,
        policy: "mtls_required",
        mappingAuth: "mtls",
        serviceBindingsFile: bindingsFile,
      });
      // The receiver ignores the shared secret entirely in this mode.
      started.ctx.config.mappingResolveToken = "";
    });
    afterAll(() => shutdown(started));

    it("resolves for the bound Host identity (past authentication: not_found for an unknown tuple)", async () => {
      const res = await tlsRequest({
        port: started.tlsPort,
        ca: pki.caCertPem,
        identity: host,
        path: RESOLVE,
      });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
    });

    it("still refuses an email join key, after authentication", async () => {
      const res = await tlsRequest({
        port: started.tlsPort,
        ca: pki.caCertPem,
        identity: host,
        path: `${RESOLVE}&email=alice%40example.com`,
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe("email_join_forbidden");
    });

    it("refuses a trusted certificate that is not bound for mapping", async () => {
      const res = await tlsRequest({
        port: started.tlsPort,
        ca: pki.caCertPem,
        identity: otherService,
        path: RESOLVE,
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "peer_not_bound" });
    });

    it("refuses the plain listener with a policy mismatch, token or not", async () => {
      const plain = await fetch(`http://127.0.0.1:${started.port}${RESOLVE}`, {
        headers: {
          authorization: `Bearer ${process.env.OPENSESAME_MAPPING_RESOLVE_TOKEN ?? ""}`,
        },
      });
      expect(plain.status).toBe(403);
      expect(await plain.json()).toEqual({ error: "listener_policy_mismatch" });
    });

    it("the bound service identity can do nothing else (AT-MAPPING-SCOPE)", async () => {
      for (const path of [
        "/v1/principals/me",
        "/v1/organizations",
        "/v1/projects",
      ]) {
        const res = await tlsRequest({
          port: started.tlsPort,
          ca: pki.caCertPem,
          identity: host,
          path,
        });
        expect(res.status, path).toBe(401);
      }
      const mutate = await tlsRequest({
        port: started.tlsPort,
        ca: pki.caCertPem,
        identity: host,
        method: "POST",
        path: "/v1/organizations",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      expect(mutate.status).toBe(401);
    });
  });

  describe("OPENSESAME_MAPPING_AUTH=shared_secret", () => {
    let started: StartedControlPlane & { tlsPort: number };
    beforeAll(async () => {
      started = await bootWithTls({
        pki,
        server,
        policy: "mtls_required",
        mappingAuth: "shared_secret",
        serviceBindingsFile: bindingsFile,
      });
    });
    afterAll(() => shutdown(started));

    it("accepts the token and refuses a bare bound certificate", async () => {
      const token = started.ctx.config.mappingResolveToken;
      expect(token.length).toBeGreaterThan(0);
      const withToken = await fetch(
        `http://127.0.0.1:${started.port}${RESOLVE}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(withToken.status).toBe(404);
      const certOnly = await tlsRequest({
        port: started.tlsPort,
        ca: pki.caCertPem,
        identity: host,
        path: RESOLVE,
      });
      expect(certOnly.status).toBe(401);
      expect(JSON.parse(certOnly.body)).toEqual({ error: "unauthorized" });
      const wrong = await fetch(`http://127.0.0.1:${started.port}${RESOLVE}`, {
        headers: { authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);
    });
  });
});
