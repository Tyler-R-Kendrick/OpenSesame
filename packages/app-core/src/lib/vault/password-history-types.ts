/**
 * The seam between retired-password digests and where they rest
 * (`password-history.ts`): the device-sealed IndexedDB database, or, while
 * the encrypted-search capability has installed one, an encrypted database
 * in which neither the vault's name nor an item's id is readable
 * (ADR 0175). A method answers `undefined` when the store cannot be had; the
 * caller then keeps the digest in memory, for this document only.
 */
export type PasswordDigestStore = Readonly<{
  add: (scope: string, digest: string) => Promise<true | undefined>;
  digestsFor: (scope: string) => Promise<string[] | undefined>;
  /** Drop every digest of a scope; resolves with how many went. */
  forget: (scope: string) => Promise<number | undefined>;
}>;
