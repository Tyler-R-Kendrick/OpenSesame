import type { AuthenticationProjectionPlan } from "../secret-fs/authentication-projection-plan.js";
/** Physical ciphertext transitions only; private owning Store independently proves authority. */
import type { PhysicalAuthenticationSnapshot } from "./physical-authentication-port.js";
export type PhysicalVaultPublicationReader = Readonly<{
  collectProjection: (
    expected: PhysicalAuthenticationSnapshot,
    key: CryptoKey,
    publicationCheck?: () => void,
  ) => Promise<PhysicalAuthenticationSnapshot>;
  publishProjection: (
    expected: PhysicalAuthenticationSnapshot,
    plan: AuthenticationProjectionPlan,
    publicationCheck?: () => void,
  ) => Promise<PhysicalAuthenticationSnapshot>;
  check: () => void;
  close: () => Promise<void>;
  publishHeader: (
    expected: PhysicalAuthenticationSnapshot,
    nextHeader: string,
    publicationCheck?: () => void,
  ) => Promise<PhysicalAuthenticationSnapshot>;
}>;
export type PhysicalVaultPublicationPort = Readonly<{
  capture: (
    tomb: string,
    original: () => void,
  ) => Promise<PhysicalVaultPublicationReader>;
}>;
