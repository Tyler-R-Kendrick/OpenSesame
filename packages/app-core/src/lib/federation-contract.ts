/** Erased federation contracts shared by synchronous state and deferred sign-in actions. */
import type { VerifiedIdTokenClaims } from "@opensesame/sdk-browser";
import type { AuthenticationIntent } from "./ambient-auth/types.js";
import type { UpstreamIdentity } from "./federation-native-session.js";

export type TrustedUpstream = {
  id: string;
  displayName: string;
  issuer: string;
  /** What the human is actually signing in with, said plainly on the button. */
  accountKind: string;
  /**
   * The OAuth client id to present, when it is not this origin's own profile.
   *
   * Compiled-in brokers and the Identity API both understand `origin:<origin>`
   * and mint a client for it on sight. A provider the operator brought — an
   * Okta org, an Auth0 tenant, an Entra directory — knows only the client it
   * was configured with, so that id travels with the upstream and is what the
   * `aud` claim is checked against (ADR 0078).
   */
  clientId?: string;
  scope?: string;
  providerHint?: string;
  /**
   * Compiled OIDC endpoints. A static page cannot discover these when the
   * broker omits CORS on `/.well-known/openid-configuration` (shoo.dev serves
   * CORS on `POST /token` and `POST /session/check` only). Authorization is a
   * top-level navigation, so it needs no CORS; the token POST already allows
   * this origin.
   */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  /**
   * Shoo speaks its own, deliberately small authorize dialect — exactly what
   * its official clients (`shoo.js`, `@shoojs/auth`) send: `client_id`,
   * `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`,
   * and `pii=true` when profile data is wanted. There is no `response_type`
   * and no `scope`; profile consent is the `pii` flag, never a scope string.
   * Everything else here speaks standard OIDC.
   */
  protocol?: "shoo" | "oidc";
  /**
   * Where a live "is this user still authorized?" answer comes from. Shoo's
   * JWKS endpoint serves no CORS, so this static page cannot verify the ES256
   * signature itself; `POST /session/check` with the id_token as bearer is the
   * check the broker built for browsers — its server verifies the signature
   * and the revocation list and answers active/login_required.
   */
  sessionCheckEndpoint?: string | undefined;
};

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type BeginSignInOptions = {
  scope?: string;
  returnTo?: string | undefined;
  orgSlug?: string | undefined;
  orgMethod?: "sso" | "saml" | undefined;
  /**
   * Which provider the brokered login page should pre-select. Sent under both
   * spellings the hosted page accepts, exactly as `packages/sdk-browser` does.
   */
  providerHint?: string;
  /**
   * Standard OIDC `login_hint`, carrying ONLY an email domain for home-realm
   * discovery (D12). The local part never reaches this function — see
   * `workEmailDomain` in `providers.ts` — so nothing personal ends up in the
   * address bar, in history, or in the hosted page's request log (T28).
   */
  loginHint?: string;
  /**
   * Standard OIDC `prompt=login` (Core §3.1.2.1). The issuer asks the
   * person to authenticate again, which is what switching accounts needs.
   * Shoo does not read `prompt` (docs.shoo.dev); a different Google account
   * means signing out at shoo.dev/me first.
   */
  prompt?: "login";
};

export type CompletedSignIn = {
  identity: UpstreamIdentity;
  /** In-app path to resume (e.g. broker/authorize query) after upstream return. */
  returnTo?: string | undefined;
  orgSlug?: string | undefined;
  orgMethod?: "sso" | "saml" | undefined;
  /**
   * The OAuth access token from the exchange, present only when the issuer was
   * the Identity API itself — the brokered flow (D8). It is the credential
   * `adoptBrokeredSession` trades for a first-party session bound to the SAME
   * principal the hosted leg admitted. The id_token from that flow carries a
   * pairwise subject for this origin and must never be linked to whatever
   * session this tab happens to hold (T23).
   */
  accessToken?: string;
  /** Saved before navigation; ambient completion must not infer this. */
  intent?: AuthenticationIntent;
  transactionId?: string;
  generation?: number;
  policyRevision?: string;
  claims?: VerifiedIdTokenClaims;
};
