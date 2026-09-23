/**
 * The providers first-run setup can point this deployment at.
 *
 * Every entry here is run **by the browser**: authorization code with PKCE,
 * against the provider's own discovery document, with a public client id the
 * operator registered for this origin. There is no OpenSesame identity service
 * behind any of them, and no server-side registration step — naming one of
 * these IS naming the identity service (ADR 0078).
 *
 * That is the whole difference from the version this replaces, which offered
 * the same four logos but registered them through `POST /v1/federated/
 * byo-upstreams` on a self-hosted control plane the operator had to stand up
 * first. Bringing your own provider should not require running ours.
 *
 * The issuer rules are shared with the Identity ceremony's presets
 * (`lib/idp-presets.ts`, ADR 0060) so an Okta domain means the same thing in
 * both places. What is added here is the second half a browser-run flow needs:
 * the client id, and where in that provider's console to find it.
 */

import {
  IDP_PRESETS,
  type IdpPresetField,
  type IssuerResult,
  issuerFromUrl,
  presetIssuer,
} from "../../lib/idp-presets.js";
import type { IdpProviderType } from "../../lib/idp-registry.js";

/** The generic issuer road's id — never an `IdpProviderType`. */
export const GENERIC_ISSUER_ID = "oidc";

/** Microsoft's road; not an `IdpProviderType` either — it has no preset. */
export const ENTRA_ID = "entra";

/** Google's road. Same story: a browser-direct provider, not a registry type. */
export const GOOGLE_ID = "google";

export type SetupProvider = {
  /** An `IdpProviderType`, `GOOGLE_ID`, `ENTRA_ID`, or `GENERIC_ISSUER_ID`. */
  id: string;
  /**
   * Which brand mark the sign-in button wears (`screens/unlock/ProviderBrand`).
   * Empty where no official treatment exists — an unbranded provider gets the
   * house button rather than somebody else's logo.
   */
  brandId: string;
  label: string;
  /** What this provider is, in the few words a chooser needs. */
  kind: string;
  /** The issuer-lead field; WorkOS has none — its issuer is fixed. */
  field: IdpPresetField | null;
  /** The issuer this option submits, or the one-line reason it cannot be. */
  issuerFor: (input: string) => IssuerResult;
  /** Where the operator finds the client id, in that provider's own words. */
  clientIdHint: string;
};

const PRESET_KIND = {
  "better-auth": "self-hosted",
  workos: "AuthKit",
  okta: "enterprise SSO",
  auth0: "enterprise SSO",
} satisfies Record<IdpProviderType, string>;

const PRESET_CLIENT_HINT = {
  "better-auth": "The OIDC client id from your Better Auth provider config.",
  workos: "Your WorkOS Client ID, from the dashboard's API keys.",
  okta: "The Client ID of an Okta app of type SPA.",
  auth0: "The Client ID of an Auth0 Single Page Application.",
} satisfies Record<IdpProviderType, string>;

/** `https://login.microsoftonline.com/<tenant>/v2.0` — Entra's v2 issuer. */
const ENTRA_TENANT_RE = /^[a-z0-9][a-z0-9.-]*$/;

function entraIssuer(input: string): IssuerResult {
  const tenant = input.trim().toLowerCase();
  if (!ENTRA_TENANT_RE.test(tenant)) {
    return {
      ok: false,
      error: "Use your tenant ID or domain, like contoso.onmicrosoft.com.",
    };
  }
  return {
    ok: true,
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
  };
}

export const SETUP_PROVIDERS: readonly SetupProvider[] = [
  // Social first: they are what most deployments actually sign people in with,
  // and both of these run entirely in the browser as a public SPA client.
  {
    id: GOOGLE_ID,
    brandId: "google",
    label: "Google",
    kind: "Google accounts",
    field: null,
    issuerFor: () => ({ ok: true, issuer: "https://accounts.google.com" }),
    clientIdHint:
      "The Web application OAuth client ID from Google Cloud Console. Add this page's origin to its Authorized JavaScript origins.",
  },
  {
    id: ENTRA_ID,
    brandId: "microsoft",
    label: "Microsoft Entra ID",
    kind: "Microsoft 365",
    field: {
      label: "Directory (tenant) ID",
      placeholder: "contoso.onmicrosoft.com",
      hint: "The tenant ID or domain from the Entra admin centre.",
    },
    issuerFor: entraIssuer,
    clientIdHint:
      "The Application (client) ID of an app registration with a Single-page application redirect.",
  },
  ...IDP_PRESETS.map((preset) => ({
    id: preset.type,
    brandId: "",
    label: preset.label,
    kind: PRESET_KIND[preset.type],
    field: preset.field,
    issuerFor: (input: string) => presetIssuer(preset.type, input),
    clientIdHint: PRESET_CLIENT_HINT[preset.type],
  })),
  {
    id: GENERIC_ISSUER_ID,
    brandId: "",
    label: "Other OIDC",
    kind: "any issuer",
    field: {
      label: "Issuer URL",
      placeholder: "https://idp.acme.com",
      hint: "Whatever the provider publishes /.well-known/openid-configuration under.",
    },
    issuerFor: (input: string) => issuerFromUrl(input),
    clientIdHint: "The client id of a public client with PKCE enabled.",
  },
];

export function setupProviderFor(id: string): SetupProvider | null {
  return SETUP_PROVIDERS.find((provider) => provider.id === id) ?? null;
}
