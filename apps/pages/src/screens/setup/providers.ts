/**
 * What the setup ceremony offers as a sign-in provider.
 *
 * The four `IDP_PRESETS` (ADR 0060) plus the road every other issuer takes:
 * a bare OIDC issuer URL, which is what `ByoProviderSheet` has always offered
 * from the sign-in screen (ADR 0055). An operator running Keycloak, Authentik,
 * Zitadel or their own server is not an edge case on first run, and sending
 * them away to find the globe icon on a screen they have not reached yet would
 * be exactly the dead end this ceremony exists to remove.
 *
 * The generic entry deliberately carries **no** `providerType`: that field is
 * the sealed IdP registry's record of which preset a binding came through, and
 * "not one of the four" is a real answer rather than a new preset.
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

export type SetupProvider = {
  /** An `IdpProviderType`, or `GENERIC_ISSUER_ID`. */
  id: string;
  label: string;
  /** What this provider is, in the few words a chooser needs. */
  kind: string;
  /** The issuer-lead field; WorkOS has none — its issuer is fixed. */
  field: IdpPresetField | null;
  /** The issuer this option submits, or the one-line reason it cannot be. */
  issuerFor: (input: string) => IssuerResult;
};

const PRESET_KIND = {
  "better-auth": "self-hosted",
  workos: "AuthKit",
  okta: "enterprise SSO",
  auth0: "enterprise SSO",
} satisfies Record<IdpProviderType, string>;

export const SETUP_PROVIDERS: readonly SetupProvider[] = [
  ...IDP_PRESETS.map((preset) => ({
    id: preset.type,
    label: preset.label,
    kind: PRESET_KIND[preset.type],
    field: preset.field,
    issuerFor: (input: string) => presetIssuer(preset.type, input),
  })),
  {
    id: GENERIC_ISSUER_ID,
    label: "Other OIDC",
    kind: "any issuer",
    field: {
      label: "Issuer URL",
      placeholder: "https://idp.acme.com",
      hint: "Discovery and client registration run server-side, behind an SSRF fence.",
    },
    issuerFor: (input: string) => issuerFromUrl(input),
  },
];

export function setupProviderFor(id: string): SetupProvider | null {
  return SETUP_PROVIDERS.find((provider) => provider.id === id) ?? null;
}
