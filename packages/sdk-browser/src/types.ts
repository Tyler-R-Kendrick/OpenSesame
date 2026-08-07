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

export interface Session {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  sub?: string;
  anonymous: boolean;
  raw: TokenResponse;
}

export interface ClaimPresentation {
  id: string;
  type: string;
  state: string;
  targetManifestDigest: string;
  expiresAt: string;
  items?: Array<{ id: string; label: string; selected?: boolean }>;
}

export interface ClaimDecision {
  acceptedItemIds: string[];
  destination?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface OpenSesameBrowserConfig {
  issuer: string;
  clientId?: string;
  redirectUri?: string;
  scopes?: string[];
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
  completeClaim(claimId: string, decision: ClaimDecision): Promise<ClaimPresentation>;
  linkIdentity(options: { provider: string }): Promise<void>;
  signOut(): Promise<void>;
}
