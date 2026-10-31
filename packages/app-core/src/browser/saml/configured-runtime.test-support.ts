/** Independent XML signer and verified TLS oracle; receiver/popup remain explicit unit ports. */
import { execFileSync } from "node:child_process";
import { X509Certificate, generateKeyPairSync, webcrypto } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509CertificateGenerator } from "@peculiar/x509";
import { expect, vi } from "vitest";
import { SignedXml } from "xml-crypto";
import { z } from "zod";
import { kvSeams } from "../../lib/kv.js";
import { tlsFetch } from "../../lib/native-s3-backup.test-support.js";
import * as receiver from "./post-session.js";
const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const P = "urn:oasis:names:tc:SAML:2.0:protocol";
export const FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
export async function configuredSamlOracle() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const keys = {
    privateKey: await webcrypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(pair.privateKey.export({ type: "pkcs8", format: "der" })),
      algorithm,
      false,
      ["sign"],
    ),
    publicKey: await webcrypto.subtle.importKey(
      "spki",
      new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" })),
      algorithm,
      true,
      ["verify"],
    ),
  };
  const generated = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: "01",
      name: "CN=Public synthetic configured SAML",
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 86400000),
      signingAlgorithm: algorithm,
      keys,
    },
    globalThis.crypto,
  );
  const der = Buffer.from(generated.rawData);
  expect(new X509Certificate(der).verify(pair.publicKey)).toBe(true);
  const certificate = der.toString("base64");
  function sign(xml: string, id: string) {
    const signer = new SignedXml({
      privateKey,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    signer.addReference({
      xpath: `//*[@ID='${id}']`,
      uri: `#${id}`,
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    signer.computeSignature(xml, {
      prefix: "ds",
      location: {
        reference: `//*[@ID='${id}']/*[local-name()='Issuer']`,
        action: "after",
      },
    });
    return signer.getSignedXml();
  }
  const metadata = `<m:EntityDescriptor xmlns:m="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="urn:configured:idp"><m:IDPSSODescriptor protocolSupportEnumeration="${P}"><m:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></m:KeyDescriptor><m:NameIDFormat>${FORMAT}</m:NameIDFormat><m:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/saml"/></m:IDPSSODescriptor></m:EntityDescriptor>`;
  return {
    metadata,
    install(events: string[], tamper = false) {
      return vi
        .spyOn(receiver, "prepareSamlPostReceiver")
        .mockImplementation(async (options) => {
          const instant = new Date(Date.now()).toISOString();
          const expiry = new Date(Date.now() + 120000).toISOString();
          const assertionId = `_${crypto.randomUUID()}`;
          const responseId = `_${crypto.randomUUID()}`;
          const xml = `<p:Response xmlns:p="${P}" xmlns:a="${A}" ID="${responseId}" Version="2.0" IssueInstant="${instant}" Destination="${options.acsUrl}" InResponseTo="${options.requestId}"><a:Issuer>urn:configured:idp</a:Issuer><p:Status><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${instant}"><a:Issuer>urn:configured:idp</a:Issuer><a:Subject><a:NameID Format="${FORMAT}">synthetic-subject</a:NameID><a:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><a:SubjectConfirmationData Recipient="${options.acsUrl}" InResponseTo="${options.requestId}" NotOnOrAfter="${expiry}"/></a:SubjectConfirmation></a:Subject><a:Conditions NotBefore="${instant}" NotOnOrAfter="${expiry}"><a:AudienceRestriction><a:Audience>urn:configured:sp</a:Audience></a:AudienceRestriction></a:Conditions><a:AuthnStatement AuthnInstant="${instant}" SessionIndex="synthetic-session" SessionNotOnOrAfter="${expiry}"><a:AuthnContext><a:AuthnContextClassRef>urn:configured:context</a:AuthnContextClassRef></a:AuthnContext></a:AuthnStatement></a:Assertion></p:Response>`;
          let response = sign(sign(xml, assertionId), responseId);
          if (tamper)
            response = response.replace("synthetic-subject", "foreign-subject");
          return {
            nonce: "a".repeat(64),
            result: Promise.resolve({
              response,
              nonce: "a".repeat(64),
              requestId: options.requestId,
              acsUrl: options.acsUrl,
            }),
            close() {
              events.push("protocol-release");
            },
          };
        });
    },
  };
}
export async function configuredSamlTls(metadata: string) {
  const directory = mkdtempSync(join(tmpdir(), "configured-saml-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    const key = readFileSync(join(directory, "key.pem"));
    const cert = readFileSync(join(directory, "cert.pem"));
    const requests: {
      path: string;
      method: string;
      cookie?: string;
      origin?: string;
    }[] = [];
    let hold = false;
    let closed = false;
    const server = createServer({ key, cert }, (request, response) => {
      requests.push({
        path: request.url ?? "",
        method: request.method ?? "",
        cookie: request.headers.cookie,
        origin: request.headers.origin,
      });
      request.socket.once("close", () => {
        closed = true;
      });
      if (
        request.url !== "/metadata?tenant=owned" ||
        request.method !== "GET"
      ) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", "application/samlmetadata+xml");
      if (hold) response.write("<held");
      else response.end(metadata);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z
      .object({ port: z.number().int().positive() })
      .parse(server.address());
    return {
      url: `https://localhost:${port}/metadata?tenant=owned`,
      fetch: tlsFetch(cert),
      requests,
      hold() {
        hold = true;
      },
      closed: () => closed,
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export type SamlSavePhase =
  | "queue"
  | "record-stage"
  | "record-close"
  | "trust-stage"
  | "trust-callback";
/** Exercise publication pauses while unrelated durable work is in flight. */
export function interleaveSamlSaveWrite(phase: SamlSavePhase) {
  return phase === "record-close"
    ? kvSeams.kvSetDurable("saml-save-unrelated", "unrelated durable work")
    : Promise.resolve();
}
/** Existing real KV seal/close code over the owned OPFS fixture; no physical browser claim. */
export async function samlSaveFixture() {
  vi.restoreAllMocks();
  const { runtimeFixture } = await import(
    "../../lib/secret-backends/runtime.test-support.js"
  );
  return runtimeFixture();
}
export async function holdSamlSavePhase(
  phase: SamlSavePhase,
  withdraw: () => void,
) {
  const { deferred } = await import(
    "../../lib/secret-backends/runtime.test-support.js"
  );
  const { originFiles } = await import("../../ports.js");
  const { kvFileName, kvSeams } = await import("../../lib/kv.js");
  const records = await import("../../lib/device-connector-records.js");
  const store = await import("../../lib/identity-connections-store.js");
  const settings = await import("../../lib/settings.js");
  const reached = deferred<void>();
  const resume = deferred<void>();
  let draining: Promise<void> = Promise.resolve();
  let releaseObserver = () => {};
  if (phase === "queue") {
    const entered = deferred<void>();
    draining = records.withDeviceConfigurationLock(async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    const write = store.writeIdentityConnection;
    vi.spyOn(store, "writeIdentityConnection").mockImplementation((...args) => {
      const pending = write(...args);
      reached.resolve();
      return pending;
    });
  } else if (phase === "trust-callback") {
    releaseObserver = settings.subscribeSettings(() => {
      releaseObserver();
      withdraw();
      reached.resolve();
    });
  } else if (phase === "record-close") {
    const durable = kvSeams.kvSetDurable;
    let held = false;
    vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(
      async (key, value, guard) => {
        // Unrelated durable work can finish before the connector publication.
        if (key !== records.DEVICE_CONNECTOR_KEYS[2] || held)
          return durable(key, value, guard);
        held = true;
        await durable(key, value, guard);
        reached.resolve();
        await resume.promise;
      },
    );
  } else {
    const open = originFiles();
    if (!open) throw new Error("Expected owned OPFS fixture");
    const root = await open();
    const get = root.getFileHandle.bind(root);
    const key =
      phase === "record-stage"
        ? records.DEVICE_CONNECTOR_KEYS[2]
        : "settings.v1";
    vi.spyOn(root, "getFileHandle").mockImplementation(
      async (name, options) => {
        const handle = await get(name, options);
        if (name === kvFileName(key)) {
          const create = handle.createWritable.bind(handle);
          vi.spyOn(handle, "createWritable").mockImplementation(
            async (options) => {
              const stream = await create(options);
              const write = stream.write.bind(stream);
              vi.spyOn(stream, "write").mockImplementation(async (data) => {
                await write(data);
                reached.resolve();
                await resume.promise;
              });
              return stream;
            },
          );
        }
        return handle;
      },
    );
  }
  return {
    reached: reached.promise,
    resume: () => resume.resolve(),
    async close() {
      resume.resolve();
      releaseObserver();
      await draining;
    },
  };
}
