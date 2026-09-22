import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenSesameProvider } from "../create-provider.js";
import type { MtlsPeer, MtlsTransport } from "../mtls/feature.js";
import {
  type DisposablePki,
  type Issued,
  createDisposablePki,
} from "./mtls-pki.js";

const API = "https://api.example.test";

/** What the Identity plane's listener does: register only verified peers. */
function socketTransport(peers: WeakMap<object, MtlsPeer>): MtlsTransport {
  return {
    peerOf: (socket) => (socket ? peers.get(overlapCast(socket)) : undefined),
  };
}

function peerFor(socket: TLSSocket): MtlsPeer | undefined {
  if (socket.authorized !== true) return undefined;
  const leaf = socket.getPeerX509Certificate();
  if (!leaf) return undefined;
  const sans = (leaf.subjectAltName ?? "").split(", ");
  return {
    certificatePem: () => leaf.toString(),
    dnsNames: () =>
      sans
        .filter((s) => s.startsWith("DNS:"))
        .map((s) => s.slice(4).toLowerCase()),
    uris: () => sans.filter((s) => s.startsWith("URI:")).map((s) => s.slice(4)),
  };
}

type Fetched = { status: number; json: JsonObject; text: string };

interface RequestOptions {
  port: number;
  pki: DisposablePki;
  identity?: Issued;
  method: string;
  path: string;
  body?: URLSearchParams | string;
  headers?: Record<string, string>;
  plain?: boolean;
}

function contentType(body: URLSearchParams | string | undefined) {
  if (body instanceof URLSearchParams) {
    return { "content-type": "application/x-www-form-urlencoded" };
  }
  return body ? { "content-type": "application/json" } : {};
}

function tlsOptions(options: RequestOptions) {
  if (options.plain) return {};
  return {
    ca: options.pki.caCertPem,
    servername: "localhost",
    ...(options.identity
      ? { cert: options.identity.certPem, key: options.identity.keyPem }
      : {}),
    agent: false,
  };
}

function request(options: RequestOptions): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const lib = options.plain ? http : https;
    const req = lib.request(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: { ...contentType(options.body), ...(options.headers ?? {}) },
        ...tlsOptions(options),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: JsonObject = {};
          try {
            json = overlapCast(JSON.parse(text));
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body.toString());
    req.end();
  });
}

function jwtPayload(token: string): JsonObject {
  const [, payload = ""] = token.split(".");
  return overlapCast(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
}

describe("RFC 8705 over a real TLS listener", () => {
  let pki: DisposablePki;
  let serverLeaf: Issued;
  let clientA: Issued;
  let clientB: Issued;
  let clientC: Issued;
  let stranger: Issued;
  let tlsServer: https.Server;
  let plainServer: http.Server;
  let port: number;
  let plainPort: number;
  let issuer: string;
  let callback: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(async () => {
    pki = createDisposablePki();
    serverLeaf = pki.issueServer("op");
    clientA = pki.issueClient("svc-a", { dns: ["svc.a.example"] });
    clientB = pki.issueClient("svc-b", { dns: ["svc.b.example"] });
    clientC = pki.issueClient("svc-c", {
      dns: ["svc.a.example"],
      reuseKeyOf: clientA,
    });
    stranger = pki
      .otherCa()
      .issueClient("stranger", { dns: ["svc.a.example"] });
    const peers = new WeakMap<object, MtlsPeer>();
    tlsServer = https.createServer(
      {
        cert: serverLeaf.certPem,
        key: serverLeaf.keyPem,
        ca: pki.caCertPem,
        requestCert: true,
        // Deliberately optional here so an untrusted certificate reaches the
        // provider as an unauthenticated socket (the Identity listener's
        // mtls_required profile rejects it at the handshake instead).
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      },
      (req, res) => callback(req, res),
    );
    tlsServer.on("secureConnection", (socket: TLSSocket) => {
      const peer = peerFor(socket);
      if (peer) peers.set(socket, peer);
    });
    plainServer = http.createServer((req, res) => callback(req, res));
    await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => plainServer.listen(0, "127.0.0.1", r));
    port = (tlsServer.address() as AddressInfo).port;
    plainPort = (plainServer.address() as AddressInfo).port;
    issuer = `https://127.0.0.1:${port}`;
    const { provider } = createOpenSesameProvider({
      issuer,
      env: { allowedResources: [API], dcrEnabled: true },
      transport: socketTransport(peers),
      clients: [
        {
          client_id: "svc-a",
          token_endpoint_auth_method: "tls_client_auth",
          tls_client_auth_san_dns: "svc.a.example",
          tls_client_certificate_bound_access_tokens: true,
          grant_types: ["client_credentials"],
          response_types: [],
          subject_type: "pairwise",
        },
      ],
    });
    callback = overlapCast(provider.callback());
  });
  afterAll(async () => {
    await new Promise<void>((r) => tlsServer.close(() => r()));
    await new Promise<void>((r) => plainServer.close(() => r()));
    pki.cleanup();
  });

  const tokenBody = () =>
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "svc-a",
      resource: API,
    });

  it("discovery advertises the implemented profile only (AT-OAUTH-METADATA)", async () => {
    const res = await request({
      port,
      pki,
      method: "GET",
      path: "/.well-known/openid-configuration",
    });
    expect(res.status).toBe(200);
    expect(res.json.tls_client_certificate_bound_access_tokens).toBe(true);
    expect(res.json.token_endpoint_auth_methods_supported).toContain(
      "tls_client_auth",
    );
    expect(res.json.token_endpoint_auth_methods_supported).not.toContain(
      "self_signed_tls_client_auth",
    );
    expect(res.json.token_endpoint_auth_methods_supported).toContain("none");
    expect(res.json.mtls_endpoint_aliases).toBeUndefined();
  });

  it("issues a certificate-bound token to the registered client presenting A (AT-OAUTH-BOUND)", async () => {
    const res = await request({
      port,
      pki,
      identity: clientA,
      method: "POST",
      path: "/token",
      body: tokenBody(),
    });
    expect(res.status).toBe(200);
    const token = String(res.json.access_token);
    const payload = jwtPayload(token);
    expect(payload.cnf).toEqual({ "x5t#S256": clientA.thumbB64u });
    expect(payload.aud).toBe(API);
    // An opaque token (no resource indicator) carries the same binding, and
    // introspection by the authenticated client reports it (JWT-format
    // tokens are deliberately not introspectable in oidc-provider).
    const opaque = await request({
      port,
      pki,
      identity: clientA,
      method: "POST",
      path: "/token",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "svc-a",
      }),
    });
    expect(opaque.status).toBe(200);
    const intro = await request({
      port,
      pki,
      identity: clientA,
      method: "POST",
      path: "/token/introspection",
      body: new URLSearchParams({
        token: String(opaque.json.access_token),
        client_id: "svc-a",
      }),
    });
    expect(intro.status).toBe(200);
    expect(intro.json.active).toBe(true);
    expect(intro.json.cnf).toEqual({ "x5t#S256": clientA.thumbB64u });
  });

  it("a different certificate carrying A's key has a different thumbprint (AT-OAUTH-SWAP)", () => {
    expect(clientC.cert.publicKey.equals(clientA.cert.publicKey)).toBe(true);
    expect(clientC.thumbB64u).not.toBe(clientA.thumbB64u);
    expect(clientB.thumbB64u).not.toBe(clientA.thumbB64u);
  });

  it("refuses the tls_client_auth client without a certificate and never falls back (AT-OAUTH-PUBLIC)", async () => {
    const none = await request({
      port,
      pki,
      method: "POST",
      path: "/token",
      body: tokenBody(),
    });
    expect(none.status).toBe(401);
    expect(none.json.error).toBe("invalid_client");
    const plain = await request({
      port: plainPort,
      pki,
      method: "POST",
      path: "/token",
      body: tokenBody(),
      plain: true,
    });
    expect(plain.status).toBe(401);
    expect(plain.json.error).toBe("invalid_client");
  });

  it("refuses an untrusted certificate and a trusted one with the wrong SAN", async () => {
    const untrusted = await request({
      port,
      pki,
      identity: stranger,
      method: "POST",
      path: "/token",
      body: tokenBody(),
    });
    expect(untrusted.status).toBe(401);
    expect(untrusted.json.error).toBe("invalid_client");
    const wrongSan = await request({
      port,
      pki,
      identity: clientB,
      method: "POST",
      path: "/token",
      body: tokenBody(),
    });
    expect(wrongSan.status).toBe(401);
    expect(wrongSan.json.error).toBe("invalid_client");
  });

  it("dynamic registration cannot claim certificate auth or bound tokens", async () => {
    const auth = await request({
      port,
      pki,
      method: "POST",
      path: "/reg",
      body: JSON.stringify({
        redirect_uris: ["https://rp.example/cb"],
        token_endpoint_auth_method: "tls_client_auth",
        tls_client_auth_san_dns: "rp.example",
      }),
    });
    expect(auth.status).toBe(400);
    expect(auth.json.error).toBe("invalid_client_metadata");
    const bound = await request({
      port,
      pki,
      method: "POST",
      path: "/reg",
      body: JSON.stringify({
        redirect_uris: ["https://rp.example/cb"],
        token_endpoint_auth_method: "none",
        tls_client_certificate_bound_access_tokens: true,
      }),
    });
    expect(bound.status).toBe(400);
    expect(bound.json.error).toBe("invalid_client_metadata");
    // The plain public-client registration path stays open.
    const ok = await request({
      port,
      pki,
      method: "POST",
      path: "/reg",
      body: JSON.stringify({
        redirect_uris: ["https://rp.example/cb"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(ok.status).toBe(201);
  });
});
