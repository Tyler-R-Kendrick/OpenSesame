/** What the fake certificate authority is told to do, and the shapes it speaks, apart from the authority itself. */
export type FakeAcmeOptions = {
  /** Whether the TXT records are published when the CA looks. */
  publish?: boolean;
  /** An order answers `processing` this many times after finalize. */
  processingPolls?: number;
  /** The first signed request is refused as carrying a stale nonce. */
  staleNonceOnce?: boolean;
  /** Every signed request is refused as carrying a stale nonce. */
  staleNonceAlways?: boolean;
  /** newOrder is refused with this problem type. */
  orderProblem?: { type: string; status: number };
  /** Requests that name an account by URL are refused as unknown. */
  accountGone?: boolean;
  /** newAccount is refused as rate limited. */
  rateLimitedAccount?: boolean;
  /** Names the CA already holds valid authorizations for. */
  alreadyValid?: string[];
  /** The directory's addresses, overridden. */
  directory?: Record<string, string>;
};

export type Jwk = { kty: string; crv: string; x: string; y: string };
export type Extra = { status?: number; headers?: Headers };
export type OrderBody = {
  status: string;
  identifiers: { type: string; value: string }[];
  authorizations: string[];
  finalize: string;
  certificate: string | null;
};
export type AcmePayload = {
  termsOfServiceAgreed?: boolean;
  identifiers?: { type: string; value: string }[];
  csr?: string;
};
export type ProtectedHeader = {
  alg: string;
  nonce: string;
  url: string;
  kid?: string;
  jwk?: Jwk;
};
