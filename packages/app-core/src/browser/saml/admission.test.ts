/** @vitest-environment jsdom */
import { X509Certificate, generateKeyPairSync, webcrypto } from "node:crypto";
import { X509CertificateGenerator } from "@peculiar/x509";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { SignedXml } from "xml-crypto";
import {
  federationSessionGeneration,
  readNativeFederationSession,
} from "../../lib/federation-native-session.js";
import { saveSession } from "../../lib/federation-publication.js";
import {
  clearFederationSessionJson,
  readFederationSessionJson,
} from "../../lib/federation-session-store.js";
import { guestAuthSeams } from "../../lib/guest-auth.js";
import { vaultStore } from "../../lib/vault/store.js";
import { createNativeOidcAdmissionRuntime } from "../oidc/admission.js";
import {
  type NativeSamlAdmissionRuntime,
  createNativeSamlAdmissionRuntime,
} from "./admission.js";
import * as receiver from "./post-session.js";
import { beginNativeSamlSignIn, consumeNativeSamlSignIn } from "./sign-in.js";
import type { NativeSamlSignInProof } from "./sign-in.js";

const runtimes: NativeSamlAdmissionRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  clearFederationSessionJson();
  vi.restoreAllMocks();
});
function runtime(): NativeSamlAdmissionRuntime {
  const current = createNativeSamlAdmissionRuntime();
  runtimes.push(current);
  return current;
}
function counterfeit(): NativeSamlSignInProof {
  // SAFETY: Intentional negative boundary probe; a JSON-shaped object cannot possess the private completed-proof WeakMap entry.
  return JSON.parse(
    '{"protocol":"saml","issuer":"urn:fake:idp","subject":"fake"}',
  ) as NativeSamlSignInProof;
}
const target = {
  connectionId: "fixture",
  label: "Fixture company",
  assertSessionCurrent() {},
};
it("refuses counterfeit scalar identity before the real canonical vault or native session can change", async () => {
  const current = runtime();
  const before = vaultStore.getSnapshot();
  const generation = federationSessionGeneration();
  await expect(current.admit(counterfeit(), target)).rejects.toThrow(
    /proof is unavailable/,
  );
  expect(vaultStore.getSnapshot()).toBe(before);
  expect(federationSessionGeneration()).toBe(generation);
  expect(readNativeFederationSession()).toBeNull();
});
it("a disposed capability cannot admit any late return or alter the current vault", async () => {
  const current = runtime();
  current.dispose();
  const before = vaultStore.getSnapshot();
  await expect(current.admit(counterfeit(), target)).rejects.toThrow(
    /disabled/,
  );
  expect(vaultStore.getSnapshot()).toBe(before);
});
it("disposing a replaced runtime cannot invalidate its successor's session generation", () => {
  const old = runtime();
  runtime();
  const generation = federationSessionGeneration();
  old.dispose();
  expect(federationSessionGeneration()).toBe(generation);
});
it("explicit native session clear invalidates the original generation synchronously", () => {
  const current = runtime();
  const generation = federationSessionGeneration();
  current.clear();
  expect(federationSessionGeneration()).not.toBe(generation);
  expect(readNativeFederationSession()).toBeNull();
});

const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
let privateKey = "";
let certificate = "";
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const keys = {
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(pair.privateKey.export({ type: "pkcs8", format: "der" })),
      algorithm,
      false,
      ["sign"],
    ),
    publicKey: await crypto.subtle.importKey(
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
      name: "CN=Public synthetic admission oracle",
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 86400000),
      signingAlgorithm: algorithm,
      keys,
    },
    crypto,
  );
  const der = Buffer.from(generated.rawData);
  expect(new X509Certificate(der).verify(pair.publicKey)).toBe(true);
  certificate = der.toString("base64");
});
afterAll(() => {
  privateKey = "";
  vi.unstubAllGlobals();
});
function sign(xml: string, id: string): string {
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
/** Actual independent XML signatures/protocol proof; the receiver and popup are unit ports, not SW/browser evidence. */
async function protocolProof(events: string[]) {
  const now = Date.now();
  const expiresAt = now + 120000;
  const expiry = new Date(expiresAt).toISOString();
  const popup = {
    marker: true,
    cancel() {
      expect(this.marker).toBe(true);
      events.push("release");
    },
    showFormConsent() {
      expect(this.marker).toBe(true);
      return { signal: new AbortController().signal, close() {} };
    },
  };
  vi.spyOn(receiver, "prepareSamlPostReceiver").mockImplementation(
    async (options) => {
      const instant = new Date(Date.now()).toISOString();
      const assertionId = `_${crypto.randomUUID()}`;
      const responseId = `_${crypto.randomUUID()}`;
      const xml = `<p:Response xmlns:p="${P}" xmlns:a="${A}" ID="${responseId}" Version="2.0" IssueInstant="${instant}" Destination="${options.acsUrl}" InResponseTo="${options.requestId}"><a:Issuer>urn:admission:idp</a:Issuer><p:Status><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${instant}"><a:Issuer>urn:admission:idp</a:Issuer><a:Subject><a:NameID Format="${FORMAT}">synthetic-subject</a:NameID><a:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><a:SubjectConfirmationData Recipient="${options.acsUrl}" InResponseTo="${options.requestId}" NotOnOrAfter="${expiry}"/></a:SubjectConfirmation></a:Subject><a:Conditions NotBefore="${instant}" NotOnOrAfter="${expiry}"><a:AudienceRestriction><a:Audience>urn:admission:sp</a:Audience></a:AudienceRestriction></a:Conditions><a:AuthnStatement AuthnInstant="${instant}" SessionIndex="synthetic-session" SessionNotOnOrAfter="${expiry}"><a:AuthnContext><a:AuthnContextClassRef>urn:admission:context</a:AuthnContextClassRef></a:AuthnContext></a:AuthnStatement></a:Assertion></p:Response>`;
      return Object.freeze({
        nonce: "a".repeat(64),
        result: Promise.resolve({
          response: sign(sign(xml, assertionId), responseId),
          nonce: "a".repeat(64),
          requestId: options.requestId,
          acsUrl: options.acsUrl,
        }),
        close() {},
      });
    },
  );
  const active = beginNativeSamlSignIn({
    scopeUrl: `${location.origin}/`,
    issuer: "urn:admission:idp",
    audience: "urn:admission:sp",
    metadataXml: `<m:EntityDescriptor xmlns:m="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="urn:admission:idp" ID="_metadata"><m:IDPSSODescriptor protocolSupportEnumeration="${P}"><m:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></m:KeyDescriptor><m:NameIDFormat>${FORMAT}</m:NameIDFormat><m:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/saml"/></m:IDPSSODescriptor></m:EntityDescriptor>`,
    nameIdFormat: FORMAT,
    authnContext: "urn:admission:context",
    forceAuthentication: false,
    timePolicy: {
      clockSkewMs: 0,
      maxAssertionAgeMs: 300000,
      maxAuthenticationAgeMs: 600000,
      maxSessionDurationMs: 600000,
    },
    reservedPopup: popup,
    owner: { signal: new AbortController().signal, assertCurrent() {} },
  });
  return { proof: await active.result, expiresAt };
}
function retirement() {
  let release: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, refuse) => {
    release = resolve;
    reject = refuse;
  });
  return { promise, release, reject };
}
it("spends genuine proof and releases its carrier before held retirement, then requests local unlock and publishes", async () => {
  const events: string[] = [];
  const { proof } = await protocolProof(events);
  const retired = retirement();
  const before = vaultStore.getSnapshot();
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...before,
    status: "locked",
  });
  const unlock = vi
    .spyOn(guestAuthSeams, "openVaultAfterSignIn")
    .mockImplementation(async () => {
      events.push("unlock");
      return false;
    });
  const request = vi.spyOn(globalThis, "fetch");
  const retire = vi.fn(() => {
    events.push("retire");
    expect(() => consumeNativeSamlSignIn(proof)).toThrow("already consumed");
    return retired.promise;
  });
  const current = runtime();
  const pending = current.admit(proof, { ...target, retireProtocol: retire });
  await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
  expect(events).toEqual(["release", "retire"]);
  expect(unlock).not.toHaveBeenCalled();
  expect(readNativeFederationSession()).toBeNull();
  retired.release();
  const identity = await pending;
  expect(events).toEqual(["release", "retire", "unlock"]);
  expect(readNativeFederationSession()).toBe(identity);
  expect(identity.assertionFormat).toBe("saml");
  expect(identity.idToken).toBe("");
  expect(identity.jwksUri).toBe("");
  expect(request).not.toHaveBeenCalled();
});
it.each(["retirement", "owner", "replacement", "expiry"])(
  "refuses %s during retirement before local unlock/publication",
  async (reason) => {
    const events: string[] = [];
    const { proof, expiresAt } = await protocolProof(events);
    const retired = retirement();
    let live = true;
    const before = vaultStore.getSnapshot();
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...before,
      status: "locked",
    });
    const unlock = vi.spyOn(guestAuthSeams, "openVaultAfterSignIn");
    const retire = vi.fn(() => retired.promise);
    const pending = runtime().admit(proof, {
      ...target,
      assertSessionCurrent() {
        if (!live) throw new Error("original owner withdrew");
      },
      retireProtocol: retire,
    });
    const outcome = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
    expect(events).toEqual(["release"]);
    if (reason === "owner") live = false;
    if (reason === "replacement") runtime();
    if (reason === "expiry")
      vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    if (reason === "retirement")
      retired.reject(new Error("original retirement failed"));
    else retired.release();
    await outcome;
    expect(unlock).not.toHaveBeenCalled();
    expect(readNativeFederationSession()).toBeNull();
    expect(events).toEqual(["release"]);
  },
);

it.each([false, true])(
  "rechecks replacement authority after the original session cleanup, withdrawal=%s",
  async (withdraw) => {
    const events: string[] = [];
    const current = runtime();
    let live = true;
    let originalReleases = 0;
    const previous = {
      ...target,
      marker: true,
      releaseSession() {
        expect(this.marker).toBe(true);
        originalReleases++;
        if (withdraw) live = false;
      },
    };
    const first = await protocolProof(events);
    await current.admit(first.proof, previous);
    const replacementCleanup = vi.fn();
    previous.releaseSession = replacementCleanup;
    const next = await protocolProof(events);
    const nextTarget = {
      ...target,
      assertSessionCurrent() {
        if (!live)
          throw new Error("replacement authority withdrew during cleanup");
      },
    };
    const pending = current.admit(next.proof, nextTarget);
    if (withdraw) {
      await expect(pending).rejects.toThrow(
        "replacement authority withdrew during cleanup",
      );
      expect(readNativeFederationSession()).toBeNull();
    } else {
      const identity = await pending;
      expect(readNativeFederationSession()).toBe(identity);
    }
    expect(originalReleases).toBe(1);
    expect(replacementCleanup).not.toHaveBeenCalled();
    expect(events).toEqual(["release", "release"]);
    expect(() => consumeNativeSamlSignIn(next.proof)).toThrow(
      "already consumed",
    );
  },
);

it("OIDC installation replaces the SAML original runtime without allowing late SAML proof to regain the session", async () => {
  const events: string[] = [];
  const before = runtime();
  const { proof } = await protocolProof(events);
  const next = createNativeOidcAdmissionRuntime();
  try {
    const generation = federationSessionGeneration();
    await expect(before.admit(proof, target)).rejects.toThrow(/replaced/);
    before.dispose();
    expect(federationSessionGeneration()).toBe(generation);
    expect(readNativeFederationSession()).toBeNull();
  } finally {
    next.dispose();
    consumeNativeSamlSignIn(proof).release();
  }
});

it.each(["release", "target"])(
  "rejects an older genuine admission when %s publishes successor metadata",
  async (hook) => {
    const events: string[] = [];
    const current = runtime();
    const successor = {
      issuer: "https://successor.example",
      upstreamId: "successor",
      idToken: "synthetic-successor-metadata",
      pairwiseSub: "successor-subject",
      audience: "successor-client",
      jwksUri: "https://successor.example/jwks",
      expiresAt: Date.now() + 60000,
    };
    let published = federationSessionGeneration();
    let released = false;
    const first = await protocolProof(events);
    await current.admit(first.proof, {
      ...target,
      releaseSession() {
        released = true;
        if (hook === "release") published = saveSession(successor);
      },
    });
    const next = await protocolProof(events);
    await expect(
      current.admit(next.proof, {
        ...target,
        assertSessionCurrent() {
          if (released && hook === "target") published = saveSession(successor);
        },
      }),
    ).rejects.toThrow("Native identity publication was superseded");
    expect(released).toBe(true);
    expect(federationSessionGeneration()).toBe(published);
    expect(readFederationSessionJson()).toBe(JSON.stringify(successor));
    expect(readNativeFederationSession()).toBeNull();
    expect(events).toEqual(["release", "release"]);
    expect(() => consumeNativeSamlSignIn(next.proof)).toThrow(
      "already consumed",
    );
  },
);
