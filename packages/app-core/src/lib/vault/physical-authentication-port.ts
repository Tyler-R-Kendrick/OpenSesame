/** Ciphertext transport data only. Port presence and body format are never authentication. */
export type PhysicalAuthenticationSnapshot = Readonly<{
  tomb: string;
  header: string | null;
  body: string | null;
}>;
export type PhysicalAuthenticationReader = Readonly<{
  check: () => void;
  revalidateRoot: () => Promise<void>;
  read: () => Promise<PhysicalAuthenticationSnapshot>;
  close: () => Promise<void>;
}>;
export type PhysicalAuthenticationPort = Readonly<{
  bodyFormat: "node-projection-v1";
  /** Callback can cancel, never authenticate a user, root or selected factors. */
  capture: (
    tomb: string,
    original: () => void,
  ) => Promise<PhysicalAuthenticationReader>;
}>;
