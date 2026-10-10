/** Bounded original device storage data; does not classify or authorize credentials. */
import type { NodeRetiredPhysicalRecord } from "./node-physical-retirement-data.js";
export type PhysicalRetiredCredentialRecord = Readonly<{
  tomb: string;
  wire: string;
  ciphertextDigest: string;
  physicalName: string;
}>;
export type PhysicalDeviceRecordReader = Readonly<{
  check: () => void;
  revalidateRoot: () => Promise<void>;
  /** Original full-revalidated retained state root DATA; absence refuses cross-port global exclusion. */
  readOriginalStateIdentity?: () => Promise<string>;
  read: (key: string, maxBytes: number) => Promise<string | null>;
  /** Explicit original legacy ciphertext data; only authenticated indexed migration may consume it. Never ordinary fallback. */
  readLegacy?: (key: string, maxBytes: number) => Promise<string | null>;
  captureLegacyInventory?: (
    tomb: string,
    paths: readonly string[],
  ) => Promise<readonly NodeRetiredPhysicalRecord[]>;
  /** Original bounded all-vault device inventory DATA; caller owns genuine global credential lease. */
  captureRetiredCredentialInventory?: () => Promise<
    readonly PhysicalRetiredCredentialRecord[]
  >;
  /** Caller holds original credential/BODY locks; expected is exact plaintext data. */
  publish: (
    key: string,
    expected: string | null,
    next: string,
    maxBytes: number,
    publicationCheck?: () => void,
  ) => Promise<void>;
  close: () => Promise<void>;
}>;
export type PhysicalDeviceRecordPort = Readonly<{
  capture: (original: () => void) => Promise<PhysicalDeviceRecordReader>;
}>;
