import { X509Certificate } from "node:crypto";
import { SAML } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { decodeSamlMessage } from "./saml.js";
import {
  type ReferenceIdp,
  type SamlMutation,
  startReferenceIdp,
} from "./testkit.js";

/**
 * Protocol conformance for the reference IdP's SAML 2.0 surface.
 *
 * The counterparty here is `@node-saml/node-saml` — the same mature SP library
 * the control plane verifies with — so "the signature is real" is proven by an
 * independent implementation, and every malformation knob is proven by the
 * refusal it produces rather than by inspecting our own output.
 */

const SP_ENTITY_ID = "http://127.0.0.1:4901/v1/saml/metadata";
const SP_ACS_URL = "http://127.0.0.1:4901/v1/saml/acs";
/** The port the standalone ACS in the IdP-initiated delivery case binds. */
const ACS_PORT = 4902;

/** Every malformation the reference IdP can emit, and what makes it one. */
const MALFORMATION_CASES: [SamlMutation, string][] = [
  ["unsigned", "an assertion with no XML-DSig at all"],
  ["wrong-element", "a valid signature that covers samlp:Status"],
  ["wrapped", "a signature-wrapped attacker assertion"],
  ["wrong-audience", "an AudienceRestriction naming another SP"],
  ["expired", "Conditions whose NotOnOrAfter has passed"],
  ["future", "Conditions whose NotBefore has not arrived"],
];

function serviceProvider(idp: ReferenceIdp): SAML {
  return new SAML({
    idpCert: idp.saml.certificatePem,
    idpIssuer: idp.saml.entityId,
    issuer: SP_ENTITY_ID,
    audience: SP_ENTITY_ID,
    callbackUrl: SP_ACS_URL,
    entryPoint: idp.saml.ssoRedirectUrl,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    acceptedClockSkewMs: 2_000,
    identifierFormat: null,
  });
}

function formValue(html: string, field: string): string {
  const match = new RegExp(`name="${field}" value="([^"]*)"`).exec(html);
  if (!match?.[1]) throw new Error(`no ${field} in the POST binding form`);
  return match[1];
}

/** Drive a real SP-initiated round trip and return the IdP's POST form. */
async function spInitiated(idp: ReferenceIdp, relayState: string) {
  const sp = serviceProvider(idp);
  const redirectUrl = await sp.getAuthorizeUrlAsync(relayState, undefined, {});
  const res = await fetch(redirectUrl, { redirect: "manual" });
  expect(res.status).toBe(200);
  const html = await res.text();
  return {
    sp,
    html,
    SAMLResponse: formValue(html, "SAMLResponse"),
    RelayState: formValue(html, "RelayState"),
  };
}

function assertionIdOf(samlResponse: string): string {
  const doc = new DOMParser().parseFromString(
    decodeSamlMessage(samlResponse),
    "text/xml",
  );
  const assertions = doc.getElementsByTagNameNS(
    "urn:oasis:names:tc:SAML:2.0:assertion",
    "Assertion",
  );
  const first = assertions.length > 0 ? assertions[0] : undefined;
  return first?.getAttribute("ID") ?? "";
}

describe("reference IdP — SAML 2.0", () => {
  it("publishes metadata carrying a real X.509 signing certificate", async () => {
    const idp = await startReferenceIdp({ protocol: "saml" });
    try {
      expect(idp.metadataUrl).toBe(idp.saml.metadataUrl);
      const res = await fetch(idp.metadataUrl);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("xml");
      const xml = await res.text();
      expect(xml).toContain(`entityID="${idp.saml.entityId}"`);
      expect(xml).toContain(idp.saml.ssoRedirectUrl);
      expect(xml).toContain(idp.saml.certificateBase64);

      // The certificate is generated at startup — nothing is committed — and
      // it is a genuine self-signed X.509, not a base64 blob.
      const certificate = new X509Certificate(idp.saml.certificatePem);
      expect(certificate.verify(certificate.publicKey)).toBe(true);
      expect(certificate.validToDate.getTime()).toBeGreaterThan(Date.now());

      const second = await startReferenceIdp({ protocol: "saml" });
      try {
        expect(second.saml.certificateBase64).not.toBe(
          idp.saml.certificateBase64,
        );
      } finally {
        await second.close();
      }
    } finally {
      await idp.close();
    }
  });

  it("completes an SP-initiated round trip the SP library accepts", async () => {
    const idp = await startReferenceIdp({
      protocol: "saml",
      subject: "saml-subject-1",
    });
    try {
      const { sp, html, SAMLResponse, RelayState } = await spInitiated(
        idp,
        "relay-1",
      );
      expect(RelayState).toBe("relay-1");
      expect(html).toContain(`<form method="post" action="${SP_ACS_URL}"`);
      expect(html).toContain("document.forms[0].submit()");

      const { profile } = await sp.validatePostResponseAsync({ SAMLResponse });
      expect(profile?.nameID).toBe("saml-subject-1");
      expect(profile?.nameIDFormat).toBe(
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      );
      expect(profile?.issuer).toBe(idp.saml.entityId);
      expect(profile?.["urn:oid:0.9.2342.19200300.100.1.3"]).toBe(
        "mock@example.com",
      );

      // InResponseTo binds the response to the AuthnRequest the SP just sent.
      const decoded = decodeSamlMessage(SAMLResponse);
      expect(decoded).toMatch(/InResponseTo="_[0-9a-f]+"/);
      expect(decoded).toContain(
        `<saml:Audience>${SP_ENTITY_ID}</saml:Audience>`,
      );
    } finally {
      await idp.close();
    }
  });

  it.each(MALFORMATION_CASES)(
    "is refused by the SP library when emitting %s",
    async (mutation) => {
      const idp = await startReferenceIdp({ protocol: "saml" });
      try {
        idp.saml.setMutation(mutation);
        const { sp, SAMLResponse } = await spInitiated(idp, "relay-neg");
        await expect(
          sp.validatePostResponseAsync({ SAMLResponse }),
        ).rejects.toThrow();
      } finally {
        await idp.close();
      }
    },
  );

  it("really wraps the signed assertion under an attacker-authored one", async () => {
    const idp = await startReferenceIdp({ protocol: "saml" });
    try {
      idp.saml.setMutation("wrapped");
      const { SAMLResponse } = await spInitiated(idp, "relay-xsw");
      const decoded = decodeSamlMessage(SAMLResponse);
      // The outer assertion carries the attacker's NameID; the honest, signed
      // assertion is still present (and still verifiable) inside saml:Advice.
      expect(decoded).toContain("attacker@evil.example");
      expect(decoded).toContain("<saml:Advice>");
      expect(decoded.indexOf("<saml:Advice>")).toBeLessThan(
        decoded.indexOf("<ds:Signature"),
      );
    } finally {
      await idp.close();
    }
  });

  it("clears the mutation so later responses validate again", async () => {
    const idp = await startReferenceIdp({ protocol: "saml" });
    try {
      idp.saml.setMutation("unsigned");
      const broken = await spInitiated(idp, "relay-a");
      await expect(
        broken.sp.validatePostResponseAsync({
          SAMLResponse: broken.SAMLResponse,
        }),
      ).rejects.toThrow();

      idp.saml.setMutation(undefined);
      const repaired = await spInitiated(idp, "relay-b");
      const { profile } = await repaired.sp.validatePostResponseAsync({
        SAMLResponse: repaired.SAMLResponse,
      });
      expect(profile?.nameID).toBeTruthy();
    } finally {
      await idp.close();
    }
  });

  it("posts a real unsolicited assertion for the IdP-initiated flow", async () => {
    const idp = await startReferenceIdp({
      protocol: "saml",
      subject: "idp-initiated-1",
    });
    try {
      const posted = await idp.idpInitiatedSamlPost(SP_ACS_URL, {
        audience: SP_ENTITY_ID,
        relayState: "/settings",
      });
      expect(posted.RelayState).toBe("/settings");

      const sp = serviceProvider(idp);
      const { profile } = await sp.validatePostResponseAsync({
        SAMLResponse: posted.SAMLResponse,
      });
      expect(profile?.nameID).toBe("idp-initiated-1");
      // Unsolicited: there is no AuthnRequest to point back at.
      expect(decodeSamlMessage(posted.SAMLResponse)).not.toContain(
        "InResponseTo",
      );

      const wrongAudience = await idp.idpInitiatedSamlPost(SP_ACS_URL, {
        audience: SP_ENTITY_ID,
        mutate: "wrong-audience",
      });
      await expect(
        sp.validatePostResponseAsync({
          SAMLResponse: wrongAudience.SAMLResponse,
        }),
      ).rejects.toThrow();
    } finally {
      await idp.close();
    }
  });

  it("re-posts an identical assertion id on demand so replay defences are testable", async () => {
    const idp = await startReferenceIdp({ protocol: "saml" });
    try {
      const sp = serviceProvider(idp);
      const first = await idp.idpInitiatedSamlPost(SP_ACS_URL, {
        audience: SP_ENTITY_ID,
        assertionId: "_pinned-assertion-id",
      });
      const second = await idp.idpInitiatedSamlPost(SP_ACS_URL, {
        audience: SP_ENTITY_ID,
        assertionId: "_pinned-assertion-id",
      });
      expect(assertionIdOf(first.SAMLResponse)).toBe("_pinned-assertion-id");
      expect(assertionIdOf(second.SAMLResponse)).toBe("_pinned-assertion-id");
      expect(first.SAMLResponse).not.toBe(second.SAMLResponse);

      // Both are individually valid: only an SP-side replay cache separates
      // them, which is exactly what this knob exists to exercise.
      for (const posted of [first, second]) {
        const { profile } = await sp.validatePostResponseAsync({
          SAMLResponse: posted.SAMLResponse,
        });
        expect(profile?.nameID).toBeTruthy();
      }

      const fresh = await idp.idpInitiatedSamlPost(SP_ACS_URL, {
        audience: SP_ENTITY_ID,
      });
      expect(assertionIdOf(fresh.SAMLResponse)).not.toBe(
        "_pinned-assertion-id",
      );
    } finally {
      await idp.close();
    }
  });

  it("delivers an IdP-initiated assertion over real HTTP to a real ACS", async () => {
    const idp = await startReferenceIdp({ protocol: "saml" });
    try {
      const received: string[] = [];
      const { createServer } = await import("node:http");
      const acs = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
          received.push(Buffer.concat(chunks).toString("utf8"));
          // Cookie-less cross-site POST: the ACS answers with a redirect, the
          // same shape the control plane's one-time-code hand-off uses.
          res.writeHead(303, { location: "/interaction/u1" });
          res.end();
        });
      });
      await new Promise<void>((resolve) =>
        acs.listen(ACS_PORT, "127.0.0.1", () => resolve()),
      );
      try {
        const res = await idp.saml.sendIdpInitiated(
          `http://127.0.0.1:${ACS_PORT}/v1/saml/acs`,
          { audience: SP_ENTITY_ID, relayState: "/vault" },
        );
        expect(res.status).toBe(303);
        expect(received).toHaveLength(1);
        const body = new URLSearchParams(received[0] ?? "");
        expect(body.get("RelayState")).toBe("/vault");
        expect(decodeSamlMessage(body.get("SAMLResponse") ?? "")).toContain(
          "<saml:Assertion",
        );
      } finally {
        await new Promise<void>((resolve) => acs.close(() => resolve()));
      }
    } finally {
      await idp.close();
    }
  });

  it("refuses an SSO request that is not a parseable AuthnRequest", async () => {
    const idp = await startReferenceIdp({ protocol: "saml" });
    try {
      const missing = await fetch(idp.saml.ssoRedirectUrl, {
        redirect: "manual",
      });
      expect(missing.status).toBe(400);

      const garbage = new URL(idp.saml.ssoRedirectUrl);
      garbage.searchParams.set(
        "SAMLRequest",
        Buffer.from("<not-a-request/>", "utf8").toString("base64"),
      );
      const refused = await fetch(garbage, { redirect: "manual" });
      expect(refused.status).toBe(400);
    } finally {
      await idp.close();
    }
  });
});
