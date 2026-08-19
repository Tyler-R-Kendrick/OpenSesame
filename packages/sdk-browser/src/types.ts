export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
  claims_supported?: string[];
  scopes_supported?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/**
 * `POST /v1/principals/provisional` response (control-plane product API).
 * Product APIs speak camelCase; this is not an RFC 6749 token endpoint.
 */
export interface ProvisionalSessionResponse {
  principalId?: string;
  state?: string;
  assurance?: string;
  sessionId?: string;
  accessToken?: string;
  expiresAt?: string;
  tokenType?: string;
}

export interface Session {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  sub?: string;
  anonymous: boolean;
  raw: TokenResponse;
}

export interface ClaimItemView {
  id: string;
  targetType: "project" | "resource" | "agent" | "device" | "connection";
  targetId: string;
  requestedAction: "attach" | "transfer" | "delegate" | "verify";
  required: boolean;
  dependencies: string[];
  state: "pending" | "accepted" | "rejected";
}

export interface ClaimPresentation {
  id: string;
  type: string;
  state: string;
  targetManifestDigest: string;
  expiresAt: string;
  items?: ClaimItemView[];
}

export interface ClaimDecision {
  /** Every accepted item by id. There is no wildcard — the server refuses one. */
  acceptedItemIds: string[];
  /**
   * The human consent code the claim's creation displayed. The server requires
   * it on completion (with a per-claim attempt fence): holding the link alone
   * must not be enough to accept, so the code travels out-of-band.
   */
  userCode?: string;
  destination?: Record<string, unknown>;
  idempotencyKey?: string;
  /**
   * The claim bearer. Only needed when the claim was presented elsewhere: this
   * client remembers the token it presented and sends it for you.
   */
  claimToken?: string;
}

export interface OpenSesameBrowserConfig {
  issuer: string;
  clientId?: string;
  redirectUri?: string;
  scopes?: string[];
  /**
   * Session/PKCE store. Defaults to `sessionStorage` (not `localStorage`) so
   * tokens do not persist across browser restarts. Inject memory or custom
   * storage in tests / locked-down embeds.
   */
  storage?: StorageLike;
  fetchImpl?: typeof fetch;
  /** Control-plane origin for claim/anonymous APIs (defaults to issuer). */
  apiBase?: string;
  windowLocation?: LocationLike;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocationLike {
  href: string;
  assign(url: string): void;
  replace(url: string): void;
}

export interface OpenSesameBrowserClient {
  signIn(options?: { provider?: string }): Promise<void>;
  /** Complete PKCE after redirect; call from redirect_uri page. */
  handleRedirectCallback(url?: string): Promise<Session>;
  continueAnonymously(): Promise<Session>;
  getSession(): Promise<Session | null>;
  presentClaim(token: string): Promise<ClaimPresentation>;
  /**
   * Current state of a claim already presented, read with its bearer. Use this
   * to resume a ceremony — presenting twice is refused, and a local snapshot
   * cannot say whether the claim has since expired, been denied or completed.
   */
  readClaim(claimId: string, claimToken: string): Promise<ClaimPresentation>;
  completeClaim(
    claimId: string,
    decision: ClaimDecision,
  ): Promise<ClaimPresentation>;
  linkIdentity(options: { provider: string }): Promise<void>;
  signOut(): Promise<void>;
}
