import { NEVER_AGENT_SECRET } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * Organization sign-in (ADR 0055, ADR 0056; ADR 0140 plan step 12): what an
 * organization's owner configures and nobody else can — the upstream its
 * people sign in through, the email domains that route work addresses to
 * it, and the SCIM tokens its directory provisions with. The PWA carries
 * all of it in Identity › Organizations, the optional
 * `enterprise.directory-provisioning` capability; the retired console's
 * `/organization` page is gone (ADR 0140).
 *
 * No agent surface does. Changing who may sign in to an organization is an
 * owner's decision, and minting a provisioning token hands its plaintext to
 * whoever asked — once — so no agent may be the one asking (ADR 0005).
 */

const OWNER_SIGN_IN: CapabilityExclusion = {
  reason:
    "which upstream an organization trusts and which addresses route to it decide who may sign in as its people; that is the organization owner's decision, and the upstream form carries a write-only client secret",
  adr: "0055-provider-registry-byo-and-org-signin.md",
};

const OWNER_PROVISIONING: CapabilityExclusion = {
  reason:
    "a provisioning token lets a directory create and remove an organization's people; listing and revoking them is the organization owner's administration",
  adr: "0056-native-saml-scim-and-directory-federation.md",
};

const PWA = "route:/identity";

function ownerOnly(
  id: string,
  title: string,
  exclusion: CapabilityExclusion,
): Capability {
  return {
    id,
    title,
    plane: "identity",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: PWA,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: exclusion,
      mcp_client: exclusion,
      webmcp: exclusion,
    },
  };
}

export const orgSignInCapabilities: readonly Capability[] = [
  ownerOnly(
    "identity.org_signin.upstream.manage",
    "Read and set an organization's sign-in upstream: OIDC issuer and client, or SAML IdP (PATCH /v1/organizations/:id)",
    OWNER_SIGN_IN,
  ),
  ownerOnly(
    "identity.org_signin.domains.manage",
    "Claim, verify and release an organization's email domains (/v1/organizations/:id/domains)",
    OWNER_SIGN_IN,
  ),
  ownerOnly(
    "identity.org_signin.scim_tokens.manage",
    "List and revoke an organization's SCIM provisioning tokens: ids and dates, never a value",
    OWNER_PROVISIONING,
  ),
  ownerOnly(
    "identity.org_signin.scim_token.mint",
    "Mint a SCIM provisioning token; its plaintext is shown once, to the owner who asked",
    NEVER_AGENT_SECRET,
  ),
];
