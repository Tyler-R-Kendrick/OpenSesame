import type { AddressInfo } from "node:net";
import type { JWK } from "jose";
import {
  OAUTH2_METADATA_PATH,
  oauth2Urls as oauth2EndpointUrls,
} from "./oauth2.js";
import { SAML_METADATA_PATH, SAML_SSO_PATH } from "./saml.js";
import type { SamlMutation } from "./saml.js";
import { createMockUpstreamIdp } from "./server.js";
import type { MintLogoutTokenOptions, MockUpstreamIdp } from "./server.js";

/**
 * The reference IdP as an embeddable test counterparty.
 *
 * `startReferenceIdp` boots the same server the dev stack runs on :9090 — real
 * HTTP, real RS256/XML-DSig over keys generated at startup — and hands back a
 * handle. It is not a stub object: every assertion a caller makes about it is
 * an assertion about bytes that crossed a socket.
 */

export type ReferenceIdpProtocol = "oidc" | "oauth2" | "saml";
export type ReferenceIdpClientMode = "origin_profile" | "confidential";

export type { SamlMutation } from "./saml.js";
export type { MintLogoutTokenOptions } from "./server.js";

export type ReferenceIdpOptions = {
  /** Which protocol `metadataUrl` describes. Every surface is always served. */
  protocol?: ReferenceIdpProtocol;
  /** Restrict the OIDC leg to one client mode so a violation is observable. */
  clientMode?: ReferenceIdpClientMode;
  /** `/authorize` answers with a self-posting form (Apple's wire behavior). */
  formPost?: boolean;
  /** Advertise and serve the RFC 7591 registration endpoint. Default `true`. */
  registration?: boolean;
  subject?: string;
  /** Bind a fixed port instead of an ephemeral one. */
  port?: number;
};

export type ReferenceIdpTokenClient = { id?: string; secret?: string };

export type ReferenceIdpOAuth2 = {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  /** GitHub's `/user/emails` — where a *confirmed* address comes from. */
  emailsUrl: string;
  metadataUrl: string;
  clientId: string;
  clientSecret: string;
  /** GitHub's numeric, immutable `id` — the only stable OAuth2 subject. */
  userId: number;
  login: string;
  /**
   * Rewrite what `/user/emails` reports, and whether the profile keeps its
   * address private. Both are real GitHub states: an account may have no
   * public email, and an address it has not confirmed is one GitHub marks
   * `verified: false`.
   */
  setEmails(
    emails: { email: string; primary: boolean; verified: boolean }[],
    options?: { profilePrivate?: boolean },
  ): void;
};

export type IdpInitiatedSamlOptions = {
  audience?: string;
  relayState?: string;
  /** Emit one of the malformations an SP must refuse (T26). */
  mutate?: SamlMutation;
  /** Fix the assertion id so the same assertion can be re-posted (replay). */
  assertionId?: string;
  subject?: string;
};

export type IdpInitiatedSamlPost = {
  SAMLResponse: string;
  RelayState?: string;
};

export type ReferenceIdpSaml = {
  entityId: string;
  metadataUrl: string;
  ssoRedirectUrl: string;
  certificatePem: string;
  certificateBase64: string;
  /** Malform every subsequent SP-initiated response until cleared. */
  setMutation(mutation?: SamlMutation): void;
  /** ACS used when an AuthnRequest omits AssertionConsumerServiceURL. */
  setAcsUrl(acsUrl?: string): void;
  sendIdpInitiated(
    acsUrl: string,
    options?: IdpInitiatedSamlOptions,
  ): Promise<Response>;
};

export type ReferenceIdp = {
  issuer: string;
  /** OIDC discovery, OAuth2 authorization-server metadata, or SAML metadata. */
  metadataUrl: string;
  close(): Promise<void>;
  setSubject(sub: string): void;
  /**
   * Claim an address, verified or not, in the OIDC id_token.
   *
   * A real IdP decides for itself what it puts in `email`/`email_verified`,
   * including an address it never checked. Tests that assert what this
   * deployment does with such a claim need to be able to make it.
   */
  setEmail(email: string, verified: boolean): void;
  lastNonce(): string | undefined;
  tokenOriginSeen(): string | undefined;
  tokenClientSeen(): ReferenceIdpTokenClient;
  mintBackchannelLogoutToken(
    sub: string,
    options?: MintLogoutTokenOptions,
  ): Promise<string>;
  idpInitiatedSamlPost(
    acsUrl: string,
    options?: IdpInitiatedSamlOptions,
  ): Promise<IdpInitiatedSamlPost>;
  /** The seeded confidential OIDC client. */
  clientId: string;
  clientSecret: string;
  registrationEndpoint?: string;
  publicJwk: JWK;
  /** Register the redirect URIs the confidential OIDC client may use. */
  setRedirectUris(redirectUris: string[]): void;
  oauth2: ReferenceIdpOAuth2;
  saml: ReferenceIdpSaml;
};

function metadataUrlFor(
  protocol: ReferenceIdpProtocol,
  issuer: string,
): string {
  if (protocol === "oauth2") return `${issuer}${OAUTH2_METADATA_PATH}`;
  if (protocol === "saml") return `${issuer}${SAML_METADATA_PATH}`;
  return `${issuer}/.well-known/openid-configuration`;
}

async function listenEphemeral(
  idp: MockUpstreamIdp,
  port: number,
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    idp.server.once("error", reject);
    idp.server.listen(port, "127.0.0.1", () => resolve());
  });
  // The pipe/string form of address() is unreachable for a host+port listen.
  // SAFETY: server.listen established the runtime AddressInfo invariant.
  const address = idp.server.address() as AddressInfo | null;
  if (address === null) {
    throw new Error("reference IdP bound no TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

export async function startReferenceIdp(
  options: ReferenceIdpOptions = {},
): Promise<ReferenceIdp> {
  const protocol = options.protocol ?? "oidc";
  const idp = await createMockUpstreamIdp({
    host: "127.0.0.1",
    port: options.port ?? 0,
    issuer: "http://127.0.0.1:0",
    formPost: options.formPost ?? false,
    registration: options.registration ?? true,
    clientMode: options.clientMode ?? "both",
  });
  if (options.subject !== undefined) idp.config.testUser.sub = options.subject;

  const issuer = await listenEphemeral(idp, options.port ?? 0);
  // Discovery, token audiences and SAML entity ids all derive from the issuer
  // at request time, so rewriting it after binding is enough.
  idp.config.issuer = issuer;
  const samlMaterial = await idp.samlKeys();
  const oauth2Endpoints = oauth2EndpointUrls(issuer);

  return {
    issuer,
    metadataUrl: metadataUrlFor(protocol, issuer),
    close: () => idp.close(),
    setEmail(email: string, verified: boolean) {
      idp.config.testUser.email = email;
      idp.config.testUser.emailVerified = verified;
    },
    setSubject(sub: string) {
      idp.config.testUser.sub = sub;
    },
    lastNonce: () => idp.observed.lastNonce,
    tokenOriginSeen: () => idp.observed.tokenOrigin,
    tokenClientSeen: () => idp.observed.tokenClient,
    mintBackchannelLogoutToken: (sub, mintOptions) =>
      idp.mintLogoutToken(sub, mintOptions),
    async idpInitiatedSamlPost(acsUrl, samlOptions) {
      const SAMLResponse = await idp.mintSamlResponse({
        acsUrl,
        ...(samlOptions?.audience !== undefined
          ? { audience: samlOptions.audience }
          : undefined),
        ...(samlOptions?.subject !== undefined
          ? { subject: samlOptions.subject }
          : undefined),
        ...(samlOptions?.mutate !== undefined
          ? { mutate: samlOptions.mutate }
          : undefined),
        ...(samlOptions?.assertionId !== undefined
          ? { assertionId: samlOptions.assertionId }
          : undefined),
      });
      return {
        SAMLResponse,
        ...(samlOptions?.relayState !== undefined
          ? { RelayState: samlOptions.relayState }
          : undefined),
      };
    },
    clientId: idp.config.clientId,
    clientSecret: idp.config.clientSecret,
    ...(idp.config.registration
      ? { registrationEndpoint: `${issuer}/register` }
      : undefined),
    publicJwk: idp.keys.publicJwk,
    setRedirectUris(redirectUris: string[]) {
      idp.config.redirectUris = [...redirectUris];
    },
    oauth2: {
      authorizeUrl: oauth2Endpoints.authorizeUrl,
      tokenUrl: oauth2Endpoints.tokenUrl,
      userinfoUrl: oauth2Endpoints.userinfoUrl,
      emailsUrl: oauth2Endpoints.emailsUrl,
      metadataUrl: oauth2Endpoints.metadataUrl,
      clientId: idp.config.oauth2.clientId,
      clientSecret: idp.config.oauth2.clientSecret,
      userId: idp.config.oauth2.userId,
      login: idp.config.oauth2.login,
      setEmails(emails, emailOptions) {
        idp.config.oauth2.emails = emails;
        if (emailOptions?.profilePrivate !== undefined) {
          idp.config.oauth2.emailPrivate = emailOptions.profilePrivate;
        }
      },
    },
    saml: {
      entityId: `${issuer}${SAML_METADATA_PATH}`,
      metadataUrl: `${issuer}${SAML_METADATA_PATH}`,
      ssoRedirectUrl: `${issuer}${SAML_SSO_PATH}`,
      certificatePem: samlMaterial.certificatePem,
      certificateBase64: samlMaterial.certificateBase64,
      setMutation: (mutation) => idp.setSamlMutation(mutation),
      setAcsUrl: (acsUrl) => idp.setSamlAcsUrl(acsUrl),
      async sendIdpInitiated(acsUrl, samlOptions) {
        const SAMLResponse = await idp.mintSamlResponse({
          acsUrl,
          ...(samlOptions?.audience !== undefined
            ? { audience: samlOptions.audience }
            : undefined),
          ...(samlOptions?.subject !== undefined
            ? { subject: samlOptions.subject }
            : undefined),
          ...(samlOptions?.mutate !== undefined
            ? { mutate: samlOptions.mutate }
            : undefined),
          ...(samlOptions?.assertionId !== undefined
            ? { assertionId: samlOptions.assertionId }
            : undefined),
        });
        const body = new URLSearchParams({ SAMLResponse });
        if (samlOptions?.relayState !== undefined) {
          body.set("RelayState", samlOptions.relayState);
        }
        return fetch(acsUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          redirect: "manual",
        });
      },
    },
  };
}
