import type { X509Certificate } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedControlPlane } from "../../server.js";
import { attestPeer } from "../peer-evidence.js";
import { replayRequest } from "../replay.js";
import {
  recordRequestEvidence,
  requestEvidenceOf,
} from "../request-evidence.js";
import {
  certificateConfirmationOf,
  decodeBearerJwtPayload,
  evaluateCertificateBinding,
} from "../resource-binding.js";
import { EMPTY_BINDINGS } from "../service-admission.js";
import { type DisposablePki, type Issued, createDisposablePki } from "./pki.js";
import { bootWithTls, shutdown } from "./server-helpers.js";
import { tlsRequest } from "./tls-client.js";

/** An unsigned JWT-shaped bearer; the gate only reads `cnf`, signature is downstream. */
function bearer(payload: object): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `Bearer ${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

function peerOfCert(cert: X509Certificate) {
  return attestPeer({
    source: "direct_tls",
    leaf: cert,
    trustProfile: { name: "client_ca" },
    trustGeneration: 1,
    credentialGeneration: 1,
    listener: "identity-tls",
    policy: "mtls_required",
    tlsVersion: "tls13",
    authenticatedAt: new Date(),
    usableForMs: 60_000,
  });
}

describe("resource-side certificate binding (unit)", () => {
  let pki: DisposablePki;
  let a: Issued;
  beforeAll(() => {
    pki = createDisposablePki();
    a = pki.issueClient("a", { dns: ["a.example"] });
  });
  afterAll(() => pki.cleanup());

  it("reads cnf from a JWT payload, an introspection body, or a token model", () => {
    expect(
      certificateConfirmationOf({ cnf: { "x5t#S256": a.thumbB64u } }),
    ).toBe(a.thumbB64u);
    expect(
      certificateConfirmationOf({
        active: true,
        cnf: { "x5t#S256": a.thumbB64u },
      }),
    ).toBe(a.thumbB64u);
    expect(certificateConfirmationOf({ "x5t#S256": a.thumbB64u })).toBe(
      a.thumbB64u,
    );
    expect(
      certificateConfirmationOf({ cnf: { jkt: "dpop-thumb" } }),
    ).toBeUndefined();
    expect(certificateConfirmationOf({ cnf: null })).toBeUndefined();
    expect(certificateConfirmationOf("x")).toBeUndefined();
  });

  it("unbound tokens pass; bound tokens need the exact peer thumbprint", () => {
    const peer = peerOfCert(a.cert);
    expect(evaluateCertificateBinding(undefined, undefined)).toEqual({
      ok: true,
      bound: false,
    });
    expect(evaluateCertificateBinding(a.thumbB64u, peer)).toEqual({
      ok: true,
      bound: true,
    });
    expect(evaluateCertificateBinding(a.thumbB64u, undefined)).toEqual({
      ok: false,
      code: "certificate_binding_missing_peer",
    });
    expect(evaluateCertificateBinding(a.thumbHex, peer)).toEqual({
      ok: false,
      code: "certificate_binding_mismatch",
    });
    expect(evaluateCertificateBinding("", peer)).toEqual({
      ok: false,
      code: "certificate_binding_mismatch",
    });
  });

  it("decodes only a well-formed bearer JWT", () => {
    expect(
      decodeBearerJwtPayload(bearer({ cnf: { "x5t#S256": "x" } })),
    ).toEqual({ cnf: { "x5t#S256": "x" } });
    expect(decodeBearerJwtPayload("Bearer pst_abc")).toBeUndefined();
    expect(decodeBearerJwtPayload("Basic abc")).toBeUndefined();
    expect(
      decodeBearerJwtPayload(
        `Bearer a.${Buffer.from("[1]").toString("base64url")}.c`,
      ),
    ).toBeUndefined();
    expect(decodeBearerJwtPayload(undefined)).toBeUndefined();
  });

  it("a replayed request keeps the original's evidence (AT-IDENTITY-SPLIT)", () => {
    const original: IncomingMessage = overlapCast(
      Readable.from([Buffer.from("grant_type=x")]),
    );
    original.headers = { host: "h" };
    original.rawHeaders = ["host", "h"];
    original.method = "POST";
    original.url = "/token";
    original.socket = overlapCast({});
    const peer = peerOfCert(a.cert);
    recordRequestEvidence(original, {
      provenance: {
        kind: "tls",
        listener: "identity-tls",
        policy: "mtls_required",
        generation: 1,
      },
      peer,
      bindings: EMPTY_BINDINGS,
    });
    const replayed = replayRequest(original, Buffer.from("grant_type=x"));
    expect(replayed.socket).toBe(original.socket);
    expect(requestEvidenceOf(replayed)).toBe(requestEvidenceOf(original));
    expect(requestEvidenceOf(replayed)?.peer).toBe(peer);
  });
});

describe("resource-side certificate binding on the real dispatcher", () => {
  let pki: DisposablePki;
  let server: Issued;
  let a: Issued;
  let b: Issued;
  let c: Issued;
  let started: StartedControlPlane & { tlsPort: number };
  const HEALTH = "/v1/health/live";
  beforeAll(async () => {
    pki = createDisposablePki();
    server = pki.issueServer("identity");
    a = pki.issueClient("a", { dns: ["a.example"] });
    b = pki.issueClient("b", { dns: ["b.example"] });
    c = pki.issueClient("c", { dns: ["a.example"], reuseKeyOf: a });
    started = await bootWithTls({ pki, server, policy: "mtls_required" });
  });
  afterAll(async () => {
    await shutdown(started);
    pki.cleanup();
  });

  const boundToA = () => ({
    authorization: bearer({ sub: "x", cnf: { "x5t#S256": a.thumbB64u } }),
  });

  it("a token bound to A is accepted from A (AT-OAUTH-BOUND)", async () => {
    const res = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: a,
      path: HEALTH,
      headers: boundToA(),
    });
    expect(res.status).toBe(200);
  });

  it("A's token is refused from B and from C, which reuses A's key (AT-OAUTH-SWAP)", async () => {
    expect(c.cert.publicKey.equals(a.cert.publicKey)).toBe(true);
    for (const identity of [b, c]) {
      const res = await tlsRequest({
        port: started.tlsPort,
        ca: pki.caCertPem,
        identity,
        path: HEALTH,
        headers: boundToA(),
      });
      expect(res.status, identity.name).toBe(401);
      expect(JSON.parse(res.body)).toEqual({
        error: "invalid_token",
        error_description: "certificate_binding_mismatch",
      });
      expect(res.headers["www-authenticate"]).toContain(
        'error="invalid_token"',
      );
    }
  });

  it("A's token is refused on the plain listener, whatever the headers claim", async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}${HEALTH}`, {
      headers: {
        ...boundToA(),
        "client-cert": `:${a.cert.raw.toString("base64")}:`,
        "x-client-cert": a.certPem.replace(/\n/g, ""),
      },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "invalid_token",
      error_description: "certificate_binding_missing_peer",
    });
  });

  it("a DPoP-bound (jkt) token and an unbound bearer are left to their own paths", async () => {
    const jkt = { authorization: bearer({ sub: "x", cnf: { jkt: "thumb" } }) };
    expect(
      (
        await tlsRequest({
          port: started.tlsPort,
          ca: pki.caCertPem,
          identity: b,
          path: HEALTH,
          headers: jkt,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`http://127.0.0.1:${started.port}${HEALTH}`, {
          headers: jkt,
        })
      ).status,
    ).toBe(200);
    const plain = { authorization: bearer({ sub: "x" }) };
    expect(
      (
        await fetch(`http://127.0.0.1:${started.port}${HEALTH}`, {
          headers: plain,
        })
      ).status,
    ).toBe(200);
  });

  it("the /token replay path sees the same evidence (AT-IDENTITY-SPLIT)", async () => {
    // jwt-bearer grants are buffered, replayed onto Hono's /oauth2/token; a
    // bound bearer on that replay is judged against the same socket peer.
    const body =
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=x";
    const mismatch = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: b,
      method: "POST",
      path: "/token",
      headers: {
        ...boundToA(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    expect(mismatch.status).toBe(401);
    expect(JSON.parse(mismatch.body).error_description).toBe(
      "certificate_binding_mismatch",
    );
    const match = await tlsRequest({
      port: started.tlsPort,
      ca: pki.caCertPem,
      identity: a,
      method: "POST",
      path: "/token",
      headers: {
        ...boundToA(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    // Past the binding gate: Hono's grant handler answers, not the gate.
    expect(match.status).not.toBe(401);
    expect(match.body).not.toContain("certificate_binding");
  });
});
