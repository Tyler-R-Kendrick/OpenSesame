/** Original application vault namespace DATA. Caller owns actual global CRED then each listed named BODY; membership is not a lease or Root grant. */
export type PhysicalApplicationVaultWipeSnapshot = Readonly<{
  physicalIdentity: string;
  scopes: readonly Readonly<{ tomb: string }>[];
}>;
export interface PhysicalApplicationVaultWipeReader {
  check(): void;
  read(): Promise<PhysicalApplicationVaultWipeSnapshot>;
  revalidate(snapshot: PhysicalApplicationVaultWipeSnapshot): Promise<void>;
  /** Must validate complete supported removal namespace under each actual named BODY before any human intent or destructive effect. DATA membership is not a lease. */
  preflightScope(
    snapshot: PhysicalApplicationVaultWipeSnapshot,
    tomb: string,
    publicationCheck: () => void,
  ): Promise<void>;
  /** Full selected/legacy ciphertext and indexed auxiliary namespace; excludes global device/duress/settings and guest scopes. Returns exact privately issued acknowledged successor. */
  removeScope(
    snapshot: PhysicalApplicationVaultWipeSnapshot,
    tomb: string,
    publicationCheck: () => void,
  ): Promise<PhysicalApplicationVaultWipeSnapshot>;
  close(): Promise<void>;
}
export interface PhysicalApplicationVaultWipePort {
  capture(original: () => void): Promise<PhysicalApplicationVaultWipeReader>;
}
