/** Identity session wire types and existing errors; neither supplies session authentication. */
export type Principal = {
  id: string;
  state: string;
  assurance: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  version: number;
  identities: Array<{
    id: string;
    kind: string;
    issuer: string;
    displayHint?: string;
    assurance: string;
  }>;
};

export type IdentitySession = {
  principalId: string;
  accessToken: string;
  /** Normalized scheme/host/port that issued this credential. */
  issuerOrigin: string;
  /**
   * Absent for a token the operator pasted in: only the API knows its horizon,
   * and guessing one would drop a working token. A 401 ends it instead.
   */
  expiresAt?: string | undefined;
  /**
   * Pasted in by the operator rather than minted here, so no cookie belongs to
   * it. Requests must withhold cookies or a surviving one answers in its place.
   */
  adopted?: boolean;
  /** Resumed from the HttpOnly cookie; no bearer is copied into JavaScript. */
  cookieOnly?: boolean;
};

export class IdentityError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
  }
}

export class HostSessionError extends Error {
  constructor(
    readonly code: "setup_required" | "identity_changed" | "invalid_host",
    message: string,
  ) {
    super(message);
    this.name = "HostSessionError";
  }
}
