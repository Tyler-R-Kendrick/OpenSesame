/**
 * The mock IdP's public surface: what callers observe, and the inputs its
 * minting helpers take. Split from `server.ts` for the file budget.
 */
import type { Server } from "node:http";
import type { MockIdpConfig, MockIdpKeys, MockIdpSamlKeys } from "./config.js";
import type { ClientRegistry } from "./registration.js";
import type { SamlMutation } from "./saml.js";

/** What the last requests carried — the assertions callers make about wire shape. */
export interface MockIdpObservations {
  lastNonce?: string | undefined;
  tokenOrigin?: string | undefined;
  tokenClient: { id?: string; secret?: string };
}

export interface MintLogoutTokenOptions {
  /**
   * OIDC Back-Channel Logout 1.0 forbids `nonce` in a logout token — it is the
   * fence against replaying an id_token as a logout. Set this to produce the
   * malformed token an endpoint must refuse.
   */
  includeNonce?: boolean;
  audience?: string;
  sessionId?: string;
}

export interface MintSamlResponseInput {
  acsUrl: string;
  /** SP entityID; defaults to the OpenSesame SP convention on the ACS origin. */
  audience?: string;
  subject?: string;
  nameIdFormat?: string;
  inResponseTo?: string;
  assertionId?: string;
  mutate?: SamlMutation;
}

export interface MockUpstreamIdp {
  config: MockIdpConfig;
  keys: MockIdpKeys;
  server: Server;
  /** Clients admitted through the RFC 7591 registration endpoint. */
  registrations: ClientRegistry;
  observed: MockIdpObservations;
  listen(): Promise<string>;
  close(): Promise<void>;
  samlKeys(): Promise<MockIdpSamlKeys>;
  setSamlMutation(mutation?: SamlMutation): void;
  setSamlAcsUrl(acsUrl?: string): void;
  mintLogoutToken(
    subject: string,
    options?: MintLogoutTokenOptions,
  ): Promise<string>;
  mintSamlResponse(input: MintSamlResponseInput): Promise<string>;
}
