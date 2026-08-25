import { z } from "zod";

/**
 * The public provider catalog (`GET /v1/federated/providers`).
 *
 * Deliberately minimal: an id to post back, a label to render, the protocol
 * kind, and whether a browser can complete the leg on its own. Issuers,
 * endpoints, client ids and secrets are NOT part of this contract — the
 * catalog is read by unauthenticated first-run surfaces (the Pages PWA, the
 * console sign-in screen), and a deployment's upstream topology is not theirs
 * to learn. Everything a leg needs beyond this is resolved server-side from
 * the registry.
 */
export const FederatedProviderSummarySchema = z.object({
  /** Registry id, posted back as the `provider` field on the login page. */
  id: z.string(),
  /** What the button says: "Sign in with {label}". */
  label: z.string(),
  kind: z.enum(["oidc", "oauth2"]),
  /**
   * True only where a static page can finish the token exchange itself — the
   * upstream serves CORS on its token endpoint and needs no client secret.
   * Everything else is brokered through the control plane's hosted login page.
   */
  browserCapable: z.boolean(),
});
export type FederatedProviderSummary = z.infer<
  typeof FederatedProviderSummarySchema
>;

export const FederatedProvidersResponseSchema = z.object({
  providers: z.array(FederatedProviderSummarySchema),
});
export type FederatedProvidersResponse = z.infer<
  typeof FederatedProvidersResponseSchema
>;
