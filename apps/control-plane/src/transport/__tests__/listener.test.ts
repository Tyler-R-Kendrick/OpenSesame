import { X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type TransportListenerConfig,
  loadTransportMaterial,
} from "../config.js";
import {
  type TransportListener,
  createTransportListener,
  peerOf,
  preparePlainRequest,
} from "../listener.js";
import { bindingPeerOf, requestEvidenceOf } from "../request-evidence.js";
import { EMPTY_BINDINGS } from "../service-admission.js";
import {
  type DisposablePki,
  type Issued,
  createDisposablePki,
  writeBindings,
} from "./pki.js";
import { pinnedAgent, rawHandshake, tlsRequest } from "./tls-client.js";

/** Whether any RFC 9440 field survived to the handler. */
function sawClientCert(req: IncomingMessage): boolean {
  if ("client-cert" in req.headers) return true;
  return req.rawHeaders.some((h) => h.toLowerCase() === "client-cert");
}

function describeEvidence(req: IncomingMessage) {
  const evidence = requestEvidenceOf(req);
  return {
    provenance: evidence?.provenance ?? null,
    peer: evidence?.peer?.view() ?? null,
    originating: evidence?.originating?.view() ?? null,
    originatingError: evidence?.originatingError ?? null,
  };
}

/** Echo what the listener recorded for this request. Never reads headers. */
function echo(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ...describeEvidence(req),
      bindingThumb: bindingPeerOf(req)?.leafThumbprintB64u() ?? null,
      socketPeer: peerOf(req.socket)?.leafThumbprintSha256() ?? null,
      sawClientCert: sawClientCert(req),
    }),
  );
}

function listenerConfig(
  pki: DisposablePki,
  server: Issued,
  policy: TransportListenerConfig["policy"],
  extra: Partial<TransportListenerConfig> = {},
): TransportListenerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    policy,
    certFile: server.certPath,
    keyFile: server.keyPath,
    minVersion: "tls13",
    trustProfile: "client_ca",
    ...(policy === "server_tls" ? undefined : { clientCaFile: pki.caCertPath }),
    ...extra,
  };
}

async function startListener(
  config: TransportListenerConfig,
): Promise<{ listener: TransportListener; port: number }> {
  const listener = createTransportListener({
    config,
    material: loadTransportMaterial(config),
    dispatch: echo,
  });
  const address = await listener.start();
  return { listener, port: address.port };
}

describe("identity TLS listener", () => {
  let pki: DisposablePki;
  let server: Issued;
  let clientA: Issued;
  let untrusted: Issued;
  let otherPki: DisposablePki;

  beforeAll(() => {
    pki = createDisposablePki();
    server = pki.issueServer("identity");
    clientA = pki.issueClient("host-a", {
      dns: ["host.mapping.example"],
      uri: ["spiffe://td.example/host"],
    });
    otherPki = pki.otherCa();
    untrusted = otherPki.issueClient("stranger", {
      dns: ["host.mapping.example"],
    });
  });
  afterAll(() => pki.cleanup());

  it("server_tls serves without a client certificate and records no peer", async () => {
    const { listener, port } = await startListener(
      listenerConfig(pki, server, "server_tls"),
    );
    try {
      const res = await tlsRequest({
        port,
        ca: pki.caCertPem,
        path: "/v1/health/live",
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.provenance).toEqual({
        kind: "tls",
        listener: "identity-tls",
        policy: "server_tls",
        generation: 1,
      });
      expect(body.peer).toBeNull();
      expect(body.socketPeer).toBeNull();
      // A certificate offered to a server_tls listener is not requested and
      // never becomes evidence either.
      const offered = await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: clientA,
        path: "/",
      });
      expect(JSON.parse(offered.body).peer).toBeNull();
    } finally {
      await listener.close();
    }
  });

  describe("mtls_required", () => {
    let listener: TransportListener;
    let port: number;
    beforeAll(async () => {
      ({ listener, port } = await startListener(
        listenerConfig(pki, server, "mtls_required"),
      ));
    });
    afterAll(() => listener.close());

    it("rejects a client with no certificate at the TLS layer, not with HTTP 401", async () => {
      const outcome = await rawHandshake({ port, ca: pki.caCertPem });
      expect(outcome.kind).not.toBe("http");
      if (outcome.kind === "post_connect") {
        // TLS 1.3: the client sees the handshake complete, then the alert.
        expect(outcome.outcome).toMatch(
          /^error:ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED|^close-without-data|^error:ECONNRESET/,
        );
      }
    });

    it("rejects a certificate from an untrusted root at the TLS layer", async () => {
      const outcome = await rawHandshake({
        port,
        ca: pki.caCertPem,
        identity: untrusted,
      });
      expect(outcome.kind).not.toBe("http");
    });

    it("yields verified evidence for a trusted certificate", async () => {
      const res = await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: clientA,
        path: "/x",
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.peer.source).toBe("direct_tls");
      expect(body.peer.listener).toBe("identity-tls");
      expect(body.peer.policy).toBe("mtls_required");
      expect(body.peer.tls_version).toBe("tls13");
      expect(body.peer.leaf_thumbprint_sha256).toBe(clientA.thumbHex);
      expect(body.peer.identities).toEqual([
        { dns_name: "host.mapping.example" },
        { spiffe_id: "spiffe://td.example/host" },
        { leaf_thumbprint_sha256: clientA.thumbHex },
      ]);
      expect(body.peer.trust_profile).toEqual({ name: "client_ca" });
      expect(Date.parse(body.peer.usable_until)).toBeGreaterThan(Date.now());
      expect(body.bindingThumb).toBe(clientA.thumbB64u);
      expect(body.socketPeer).toBe(clientA.thumbHex);
      // The view is a safe DTO: no subject, no PEM, no key.
      expect(JSON.stringify(body.peer)).not.toMatch(/BEGIN|CN=|subject/);
    });

    it("does not resume a TLS session offered by a previous connection", async () => {
      const first = await rawHandshake({
        port,
        ca: pki.caCertPem,
        identity: clientA,
      });
      expect(first.kind).toBe("http");
      if (first.kind !== "http") return;
      expect(first.session).toBeDefined();
      const second = await rawHandshake({
        port,
        ca: pki.caCertPem,
        identity: clientA,
        ...(first.session ? { session: first.session } : undefined),
      });
      expect(second.kind).toBe("http");
      if (second.kind === "http") expect(second.reused).toBe(false);
    });

    it("ignores caller-supplied certificate headers on the TLS listener (AT-TLS-FAKECONTEXT)", async () => {
      const forged = untrusted.certPem.replace(/\n/g, "");
      const res = await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: clientA,
        path: "/x",
        headers: {
          "x-client-cert": forged,
          "client-cert": `:${untrusted.cert.raw.toString("base64")}:`,
          "x-forwarded-client-cert": `Cert="${forged}"`,
        },
      });
      const body = JSON.parse(res.body);
      // Not on the trusted_ingress policy: the RFC 9440 fields are stripped
      // before any handler, never parsed.
      expect(body.originating).toBeNull();
      expect(body.sawClientCert).toBe(false);
      expect(body.peer.leaf_thumbprint_sha256).toBe(clientA.thumbHex);
      expect(body.bindingThumb).toBe(clientA.thumbB64u);
    });

    it("restartTransport swaps the server certificate without dropping an open connection", async () => {
      const agent = pinnedAgent(pki.caCertPem, clientA);
      try {
        const before = await tlsRequest({
          port,
          ca: pki.caCertPem,
          identity: clientA,
          path: "/1",
          agent,
        });
        const oldFingerprint =
          before.socket.getPeerX509Certificate()?.fingerprint256;
        expect(oldFingerprint).toBe(server.cert.fingerprint256);

        const renewed = pki.issueServer("identity-renewed");
        const { copyFileSync } = await import("node:fs");
        copyFileSync(renewed.certPath, server.certPath);
        copyFileSync(renewed.keyPath, server.keyPath);
        const generations = await listener.restartTransport();
        expect(generations.credentialGeneration).toBe(2);

        // The already-established connection keeps working on the old identity.
        const during = await tlsRequest({
          port,
          ca: pki.caCertPem,
          identity: clientA,
          path: "/2",
          agent,
        });
        expect(during.status).toBe(200);
        expect(during.socket).toBe(before.socket);

        // A new handshake sees the renewed leaf and a new generation.
        const after = await tlsRequest({
          port,
          ca: pki.caCertPem,
          identity: clientA,
          path: "/3",
        });
        expect(after.socket.getPeerX509Certificate()?.fingerprint256).toBe(
          renewed.cert.fingerprint256,
        );
        expect(JSON.parse(after.body).provenance.generation).toBe(2);
        expect(JSON.parse(after.body).peer.credential_generation).toBe(2);
      } finally {
        agent.destroy();
      }
    });

    it("restartTransport refuses a mismatched key pair and keeps serving the old material", async () => {
      const other = pki.issueServer("identity-mismatch");
      const { readFileSync, writeFileSync } = await import("node:fs");
      const current = readFileSync(server.keyPath);
      writeFileSync(server.keyPath, other.keyPem);
      await expect(listener.restartTransport()).rejects.toThrow(
        /key_pair_mismatch/,
      );
      writeFileSync(server.keyPath, current);
      const res = await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: clientA,
        path: "/4",
      });
      expect(res.status).toBe(200);
    });
  });

  it("the plain listener never produces a peer, whatever the request claims", async () => {
    const http = await import("node:http");
    const plain = http.createServer((req, res) => {
      preparePlainRequest(req, EMPTY_BINDINGS);
      echo(req, res);
    });
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    try {
      // SAFETY: a listening TCP server reports an AddressInfo.
      const port = (plain.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/x`, {
        headers: {
          "x-client-cert": clientA.certPem.replace(/\n/g, ""),
          "client-cert": `:${clientA.cert.raw.toString("base64")}:`,
          "x-forwarded-client-cert":
            "Cert=whatever;Subject=host.mapping.example",
          "content-type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          verified: true,
          thumbprint: clientA.thumbHex,
          principal: "prn_x",
        }),
      });
      const body = await res.json();
      expect(body.provenance).toEqual({
        kind: "plain",
        listener: "identity-plain",
      });
      expect(body.peer).toBeNull();
      expect(body.originating).toBeNull();
      expect(body.bindingThumb).toBeNull();
      expect(body.socketPeer).toBeNull();
      expect(body.sawClientCert).toBe(false);
    } finally {
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });
});
