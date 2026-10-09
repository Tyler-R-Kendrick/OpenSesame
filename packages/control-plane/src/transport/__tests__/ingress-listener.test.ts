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
} from "../listener.js";
import { bindingPeerOf, requestEvidenceOf } from "../request-evidence.js";
import {
  type DisposablePki,
  type Issued,
  createDisposablePki,
  writeBindings,
} from "./pki.js";
import { pinnedAgent, tlsRequest } from "./tls-client.js";

function echo(req: IncomingMessage, res: ServerResponse): void {
  const evidence = requestEvidenceOf(req);
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      peer: evidence?.peer?.view() ?? null,
      originating: evidence?.originating?.view() ?? null,
      originatingError: evidence?.originatingError ?? null,
      bindingThumb: bindingPeerOf(req)?.leafThumbprintB64u() ?? null,
    }),
  );
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

describe("identity TLS listener: trusted_ingress", () => {
  let pki: DisposablePki;
  let server: Issued;
  let clientA: Issued;
  beforeAll(() => {
    pki = createDisposablePki();
    server = pki.issueServer("identity");
    clientA = pki.issueClient("host-a", { dns: ["host.mapping.example"] });
  });
  afterAll(() => pki.cleanup());

  describe("trusted_ingress", () => {
    let listener: TransportListener;
    let port: number;
    let ingress: Issued;
    let userPki: DisposablePki;
    let user1: Issued;
    let user2: Issued;
    beforeAll(async () => {
      ingress = pki.issueClient("edge", { dns: ["edge.ingress.example"] });
      userPki = pki.otherCa();
      user1 = userPki.issueClient("user-1", { dns: ["user1.example"] });
      user2 = userPki.issueClient("user-2", { dns: ["user2.example"] });
      const bindings = writeBindings(pki, {
        revision: 1,
        bindings: [
          {
            id: "edge",
            revision: 1,
            enabled: true,
            revoked: false,
            scope: "deployment",
            trust_profile: { name: "client_ca" },
            peer: { dns_name: "edge.ingress.example" },
            service_principal: "svc_edge",
            purpose: "trusted_ingress",
            allowed_operations: ["ingress.forward"],
            allowed_audiences: [],
            not_after: null,
            denied_thumbprints: [],
          },
        ],
      });
      ({ listener, port } = await startListener({
        host: "127.0.0.1",
        port: 0,
        policy: "trusted_ingress",
        certFile: server.certPath,
        keyFile: server.keyPath,
        clientCaFile: pki.caCertPath,
        minVersion: "tls13",
        trustProfile: "client_ca",
        serviceBindingsFile: bindings,
        ingressOriginatingTrustFile: userPki.caCertPath,
      }));
    });
    afterAll(() => listener.close());

    const clientCert = (leaf: Issued) =>
      `:${leaf.cert.raw.toString("base64")}:`;

    it("attaches originating evidence per request on one pooled ingress socket (AT-INGRESS-POOL)", async () => {
      const agent = pinnedAgent(pki.caCertPem, ingress);
      try {
        const first = await tlsRequest({
          port,
          ca: pki.caCertPem,
          identity: ingress,
          agent,
          path: "/a",
          headers: { "client-cert": clientCert(user1) },
        });
        const second = await tlsRequest({
          port,
          ca: pki.caCertPem,
          identity: ingress,
          agent,
          path: "/b",
          headers: { "client-cert": clientCert(user2) },
        });
        const third = await tlsRequest({
          port,
          ca: pki.caCertPem,
          identity: ingress,
          agent,
          path: "/c",
        });
        expect(second.socket).toBe(first.socket);
        expect(third.socket).toBe(first.socket);
        const a = JSON.parse(first.body);
        const b = JSON.parse(second.body);
        const c = JSON.parse(third.body);
        expect(a.originating.source).toBe("trusted_ingress_assertion");
        expect(a.originating.leaf_thumbprint_sha256).toBe(user1.thumbHex);
        expect(a.originating.ingress.leaf_thumbprint_sha256).toBe(
          ingress.thumbHex,
        );
        expect(a.bindingThumb).toBe(user1.thumbB64u);
        expect(b.originating.leaf_thumbprint_sha256).toBe(user2.thumbHex);
        expect(b.bindingThumb).toBe(user2.thumbB64u);
        // No header on the third request: nothing is inherited from the socket.
        expect(c.originating).toBeNull();
        expect(c.bindingThumb).toBeNull();
        expect(c.peer.leaf_thumbprint_sha256).toBe(ingress.thumbHex);
      } finally {
        agent.destroy();
      }
    });

    it("refuses forwarded evidence that does not chain to the originating trust", async () => {
      const res = await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: ingress,
        path: "/x",
        headers: { "client-cert": clientCert(clientA) },
      });
      const body = JSON.parse(res.body);
      expect(body.originating).toBeNull();
      expect(body.originatingError).toMatch(
        /forwarded_evidence_unverified|trust_unknown/,
      );
      expect(body.bindingThumb).toBeNull();
    });

    it("refuses a conflicting or malformed leaf field deterministically", async () => {
      const dup = await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: ingress,
        path: "/x",
        headers: {
          "client-cert": `${clientCert(user1)}, ${clientCert(user2)}`,
        },
      });
      expect(JSON.parse(dup.body).originatingError).toMatch(
        /leaf_repeated|malformed_structured_field/,
      );
      const junk = await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: ingress,
        path: "/x",
        headers: { "client-cert": "not-a-byte-sequence" },
      });
      expect(JSON.parse(junk.body).originatingError).toMatch(
        /malformed_structured_field|not_byte_sequence/,
      );
    });

    it("refuses forwarded evidence from a peer that is not a bound ingress", async () => {
      const res = await tlsRequest({
        port,
        ca: pki.caCertPem,
        identity: clientA,
        path: "/x",
        headers: { "client-cert": clientCert(user1) },
      });
      const body = JSON.parse(res.body);
      expect(body.originating).toBeNull();
      expect(body.originatingError).toMatch(
        /not bound to forward: peer_not_bound/,
      );
      expect(body.bindingThumb).toBeNull();
    });

    it("parses the forwarded leaf as the same DER the user presented", () => {
      expect(new X509Certificate(user1.cert.raw).fingerprint256).toBe(
        user1.cert.fingerprint256,
      );
    });
  });
});
