/** Original physical current-generation data and atomic ciphertext ACK only. Never owner admission. */
import type { AuthenticationCiphertext } from "./authentication-storage.js";
import type { NodeAuxiliarySnapshot } from "./node-auxiliary-generation-data.js";
import type {
  GenerationChange,
  NodeGeneration,
} from "./node-generation-format.js";
export type PhysicalVaultGeneration = Readonly<{
  record: Uint8Array | null;
  generation: NodeGeneration | null;
}>;
export type PhysicalVaultGenerationReader = Readonly<{
  check: () => void;
  readOriginalRootIdentity?: () => Promise<string>;
  revalidateRoot: () => Promise<void>;
  read: () => Promise<PhysicalVaultGeneration>;
  auditPhysical?: (
    snapshot: AuthenticationCiphertext,
    auxiliary: NodeAuxiliarySnapshot,
  ) => Promise<void>;
  recoverRetirement?: (
    expected: Uint8Array,
    cancellation: () => void,
  ) => Promise<PhysicalVaultGeneration>;
  publish: (
    expected: Uint8Array | null,
    change: GenerationChange,
    original: () => void,
  ) => Promise<PhysicalVaultGeneration>;
  close: () => Promise<void>;
}>;
export type PhysicalVaultGenerationPort = Readonly<{
  capture: (
    tomb: string,
    original: () => void,
  ) => Promise<PhysicalVaultGenerationReader>;
}>;
