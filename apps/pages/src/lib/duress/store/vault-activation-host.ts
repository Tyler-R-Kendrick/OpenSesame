import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * STORE-E — vault store surface for duress activation coordination.
 */

import type { VaultHeader } from "../../vault/crypto.js";
import { discardTombCaches } from "../../vault/tomb-migration.js";
import { GUEST_TOMB } from "../../vfs.js";

export type DuressVaultActivationHost = Readonly<{
  activeTomb: () => string;
  isGuestOrEphemeral: () => boolean;
  isOnboarding: () => boolean;
  flushPendingWrites: () => Promise<void>;
  cancelPendingOps: () => void;
  discardCaches: () => void;
  sessionGeneration: () => number;
}>;

export function createDuressVaultActivationHost(input: {
  activeTomb: () => string;
  ephemeral: () => boolean;
  header: () => VaultHeader | null;
  vaultKey: () => CryptoKey | null;
  flushPendingWrites: () => Promise<void>;
  cancelPendingOps: () => void;
  sessionGeneration: () => number;
}): DuressVaultActivationHost {
  return {
    activeTomb: input.activeTomb,
    isGuestOrEphemeral: () =>
      input.ephemeral() || input.activeTomb() === GUEST_TOMB,
    isOnboarding: () =>
      input.header() === null &&
      !input.ephemeral() &&
      input.vaultKey() === null,
    flushPendingWrites: input.flushPendingWrites,
    cancelPendingOps: input.cancelPendingOps,
    discardCaches: () => discardTombCaches(),
    sessionGeneration: input.sessionGeneration,
  };
}
