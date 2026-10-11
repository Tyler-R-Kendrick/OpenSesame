/** Original physical ciphertext DATA only; catalogue membership never grants locks, MFA or REAL. */
export type PhysicalCurrentCredentialScope = Readonly<{
  tomb: string;
  physicalIdentity: string;
}>;
export type PhysicalCurrentCredentialCatalogueSnapshot = Readonly<{
  physicalIdentity: string;
  scopes: readonly PhysicalCurrentCredentialScope[];
}>;
export type PhysicalCurrentCredentialBodyFormat =
  | "flat-v1"
  | "node-projection-v1";
type ScopeLocation = Readonly<{ tomb: string; physicalIdentity: string }>;
export type PhysicalCurrentCredentialScopeSnapshot =
  | (ScopeLocation &
      Readonly<{
        kind: "selected";
        marker: Uint8Array;
        bodyFormat: PhysicalCurrentCredentialBodyFormat;
        header: string;
        body: string;
      }>)
  | (ScopeLocation &
      Readonly<{
        kind: "deleted";
        marker: Uint8Array;
      }>)
  | (ScopeLocation &
      Readonly<{
        kind: "legacy";
        bodyFormat: PhysicalCurrentCredentialBodyFormat;
        header: string;
        body: string;
      }>);
export type PhysicalCurrentCredentialScopeReader = Readonly<{
  check: () => void;
  read: () => Promise<PhysicalCurrentCredentialScopeSnapshot>;
  revalidate: (
    snapshot: PhysicalCurrentCredentialScopeSnapshot,
  ) => Promise<void>;
  close: () => Promise<void>;
}>;
export type PhysicalCurrentCredentialCatalogueReader = Readonly<{
  check: () => void;
  read: () => Promise<PhysicalCurrentCredentialCatalogueSnapshot>;
  revalidate: (
    snapshot: PhysicalCurrentCredentialCatalogueSnapshot,
  ) => Promise<void>;
  /** Exact privately issued row only. Caller owns genuine CRED then this foreign BODY through close. */
  captureScope: (
    scope: PhysicalCurrentCredentialScope,
    original: () => void,
  ) => Promise<PhysicalCurrentCredentialScopeReader>;
  close: () => Promise<void>;
}>;
export type PhysicalCurrentCredentialCataloguePort = Readonly<{
  /** Caller retains genuine global CRED; callback cancellation cannot authenticate any scope. */
  capture: (
    original: () => void,
  ) => Promise<PhysicalCurrentCredentialCatalogueReader>;
}>;
