/** @vitest-environment jsdom */
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SignedXml } from "xml-crypto";
import type { SamlPendingRequest } from "./assertion-conditions.js";
import { claimNativeSamlAssertion } from "./assertion-replay.js";
import { validateSamlAssertion } from "./assertion.js";
import {
  type NativeSamlSignInOptions,
  type NativeSamlSignInProof,
  beginNativeSamlSignIn,
  consumeNativeSamlSignIn,
} from "./sign-in.js";
import { verifySamlXmlSignature } from "./xml-signature.js";

const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const FORMAT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const POLICY = {
  clockSkewMs: 0,
  maxAssertionAgeMs: 300000,
  maxAuthenticationAgeMs: 600000,
  maxSessionDurationMs: 600000,
};
let privateKey = "";
let anchor = new Uint8Array();
beforeAll(() => {
  vi.stubGlobal("crypto", webcrypto);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  anchor = new Uint8Array(
    pair.publicKey.export({ type: "spki", format: "der" }),
  );
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
async function claims(id: string, issuer = "urn:replay:idp", now = Date.now()) {
  const request: SamlPendingRequest = {
    requestId: `_${crypto.randomUUID()}`,
    issuer,
    audience: "urn:replay:sp",
    acsUrl: "https://pwa.example.test/app/auth/native-saml",
    issuedAt: now,
    expiresAt: now + 60000,
    nameIdFormat: FORMAT,
    authnContext: "urn:replay:context",
    forceAuthentication: false,
  };
  const time = new Date(now).toISOString();
  const expiry = new Date(now + 120000).toISOString();
  const responseId = `_${crypto.randomUUID()}`;
  const xml = `<p:Response xmlns:p="${P}" xmlns:a="${A}" ID="${responseId}" Version="2.0" IssueInstant="${time}" Destination="${request.acsUrl}" InResponseTo="${request.requestId}"><a:Issuer>${issuer}</a:Issuer><p:Status><p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></p:Status><a:Assertion ID="${id}" Version="2.0" IssueInstant="${time}"><a:Issuer>${issuer}</a:Issuer><a:Subject><a:NameID Format="${FORMAT}">synthetic-subject</a:NameID><a:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><a:SubjectConfirmationData Recipient="${request.acsUrl}" InResponseTo="${request.requestId}" NotOnOrAfter="${expiry}"/></a:SubjectConfirmation></a:Subject><a:Conditions NotBefore="${time}" NotOnOrAfter="${expiry}"><a:AudienceRestriction><a:Audience>${request.audience}</a:Audience></a:AudienceRestriction></a:Conditions><a:AuthnStatement AuthnInstant="${time}" SessionIndex="synthetic-session" SessionNotOnOrAfter="${expiry}"><a:AuthnContext><a:AuthnContextClassRef>urn:replay:context</a:AuthnContextClassRef></a:AuthnContext></a:AuthnStatement></a:Assertion></p:Response>`;
  const proof = await verifySamlXmlSignature(
    sign(sign(xml, id), responseId),
    [anchor],
    { signal: new AbortController().signal, assertCurrent() {} },
  );
  return validateSamlAssertion(proof, request, POLICY, now);
}
it("claims a genuinely signature/protocol-verified assertion once synchronously", async () => {
  const verified = await claims(`_${crypto.randomUUID()}`);
  claimNativeSamlAssertion(verified, verified.acceptedAt);
  expect(() => claimNativeSamlAssertion(verified, verified.acceptedAt)).toThrow(
    /already used/,
  );
});
it("rejects a reused signed assertion ID even when independently signed for a different valid original request", async () => {
  const id = `_${crypto.randomUUID()}`;
  const first = await claims(id);
  const second = await claims(id);
  expect(first.requestId).not.toBe(second.requestId);
  claimNativeSamlAssertion(first, first.acceptedAt);
  expect(() => claimNativeSamlAssertion(second, second.acceptedAt)).toThrow(
    /already used/,
  );
});
it("namespaces replay IDs by the exact signature-verified issuer", async () => {
  const id = `_${crypto.randomUUID()}`;
  const first = await claims(id, "urn:first:idp");
  const second = await claims(id, "urn:second:idp");
  claimNativeSamlAssertion(first, first.acceptedAt);
  expect(() =>
    claimNativeSamlAssertion(second, second.acceptedAt),
  ).not.toThrow();
});
it("refuses an assertion that expires after genuine verification before its replay claim", async () => {
  const verified = await claims(`_${crypto.randomUUID()}`);
  expect(() =>
    claimNativeSamlAssertion(verified, verified.validUntil),
  ).toThrow();
});
it("drops expired replay custody before a later genuinely signed issuance using that ID", async () => {
  const id = `_${crypto.randomUUID()}`;
  const first = await claims(id);
  claimNativeSamlAssertion(first, first.acceptedAt);
  const later = await claims(id, first.issuer, first.validUntil + 1);
  expect(() => claimNativeSamlAssertion(later, later.acceptedAt)).not.toThrow();
});
it("refuses copied/JSON scalar claims as native sign-in proof", async () => {
  const verified = await claims(`_${crypto.randomUUID()}`);
  // SAFETY: Intentional negative boundary probe: scalar claims never possess the private WeakMap proof.
  const counterfeit = JSON.parse(
    JSON.stringify(verified),
  ) as NativeSamlSignInProof;
  expect(() => consumeNativeSamlSignIn(counterfeit)).toThrow(/unavailable/);
});
it("does not reserve or submit a popup for an already-cancelled originating owner", () => {
  const open = vi.spyOn(window, "open");
  try {
    expect(() =>
      beginNativeSamlSignIn({
        scopeUrl: `${location.origin}/`,
        issuer: "urn:oracle:idp",
        audience: "urn:oracle:sp",
        metadataXml: "",
        nameIdFormat: FORMAT,
        authnContext: "",
        forceAuthentication: false,
        timePolicy: POLICY,
        owner: { signal: AbortSignal.abort(), assertCurrent() {} },
      }),
    ).toThrow();
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
});

function setup() {
  const popup = {
    cancel: vi.fn(),
    showFormConsent: vi.fn(() => {
      throw new Error("No negative fixture may reach provider consent");
    }),
  };
  const assertCurrent = vi.fn();
  const options: NativeSamlSignInOptions = {
    scopeUrl: `${location.origin}/`,
    issuer: "urn:fixture:idp",
    audience: "urn:fixture:sp",
    metadataXml: "",
    nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    authnContext: "",
    forceAuthentication: false,
    timePolicy: {
      clockSkewMs: 0,
      maxAssertionAgeMs: 300000,
      maxAuthenticationAgeMs: 600000,
      maxSessionDurationMs: 600000,
    },
    reservedPopup: popup,
    owner: { signal: new AbortController().signal, assertCurrent },
  };
  return { popup, assertCurrent, options };
}
function metadataResult() {
  let resolve: (xml: string) => void = () => undefined;
  const promise = new Promise<string>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
it.each(["none", "both"])(
  "refuses %s metadata sources without provider consent",
  async (mode) => {
    const { options, popup } = setup();
    const load = vi.fn(async () => "never parsed");
    const active = beginNativeSamlSignIn({
      ...options,
      metadataXml: mode === "both" ? "never parsed" : "",
      loadMetadataXml: mode === "both" ? load : undefined,
    });
    await expect(active.result).rejects.toThrow("exactly one");
    expect(load).not.toHaveBeenCalled();
    expect(popup.showFormConsent).not.toHaveBeenCalled();
    expect(popup.cancel).toHaveBeenCalledOnce();
  },
);
it("rechecks original ownership after an actual asynchronous metadata loader before XML parsing", async () => {
  const { options, popup, assertCurrent } = setup();
  const loaded = metadataResult();
  const load = vi.fn(() => loaded.promise);
  const active = beginNativeSamlSignIn({ ...options, loadMetadataXml: load });
  expect(load).toHaveBeenCalledOnce();
  assertCurrent.mockImplementation(() => {
    throw new Error("Original saved connection changed");
  });
  loaded.resolve("<not-trusted-metadata/>");
  await expect(active.result).rejects.toThrow(
    "Original saved connection changed",
  );
  expect(popup.showFormConsent).not.toHaveBeenCalled();
  expect(popup.cancel).toHaveBeenCalledOnce();
});
it("cancellation while metadata is pending cannot resume consent or proof publication", async () => {
  const { options, popup } = setup();
  const loaded = metadataResult();
  const active = beginNativeSamlSignIn({
    ...options,
    loadMetadataXml: () => loaded.promise,
  });
  active.cancel();
  expect(popup.cancel).toHaveBeenCalledOnce();
  loaded.resolve("<not-trusted-metadata/>");
  await expect(active.result).rejects.toThrow(/cancelled|expired|aborted/);
  expect(popup.showFormConsent).not.toHaveBeenCalled();
});
it("a metadata transport failure closes the original reservation", async () => {
  const { options, popup } = setup();
  const active = beginNativeSamlSignIn({
    ...options,
    loadMetadataXml: async () => {
      throw new Error("Metadata transport rejected");
    },
  });
  await expect(active.result).rejects.toThrow("Metadata transport rejected");
  expect(popup.cancel).toHaveBeenCalledOnce();
  expect(popup.showFormConsent).not.toHaveBeenCalled();
});
it("invalid originating scope releases a reservation supplied before lazy protocol loading", () => {
  const { options, popup } = setup();
  expect(() =>
    beginNativeSamlSignIn({ ...options, scopeUrl: "https://another.example/" }),
  ).toThrow("scope");
  expect(popup.cancel).toHaveBeenCalledOnce();
  expect(popup.showFormConsent).not.toHaveBeenCalled();
});

it.each(["signal", "assertion"])(
  "refuses original owner %s replacement after metadata awaits",
  async (changed) => {
    const { options, popup } = setup();
    const original = {
      signal: new AbortController().signal,
      assertCurrent() {},
    };
    const loaded = metadataResult();
    const active = beginNativeSamlSignIn({
      ...options,
      owner: original,
      loadMetadataXml: () => loaded.promise,
    });
    if (changed === "signal") original.signal = new AbortController().signal;
    else original.assertCurrent = () => undefined;
    loaded.resolve("<never-trusted-metadata/>");
    await expect(active.result).rejects.toThrow("Original SAML owner changed");
    expect(popup.showFormConsent).not.toHaveBeenCalled();
    expect(popup.cancel).toHaveBeenCalledOnce();
  },
);
it("preserves original owner receiver and refuses reentrant method replacement synchronously", () => {
  const { options, popup } = setup();
  const original = {
    marker: true,
    signal: new AbortController().signal,
    assertCurrent() {
      expect(this.marker).toBe(true);
      this.assertCurrent = () => undefined;
    },
  };
  expect(() => beginNativeSamlSignIn({ ...options, owner: original })).toThrow(
    "Original SAML owner changed",
  );
  expect(popup.showFormConsent).not.toHaveBeenCalled();
  expect(popup.cancel).toHaveBeenCalledOnce();
});
