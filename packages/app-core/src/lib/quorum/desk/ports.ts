/**
 * What the ceremonies of a circle need from the page they run in (ADR 0186
 * §10). The desk is the layer between the protocol (`../`) and the screens: it
 * holds no key and draws nothing, it runs one ceremony step at a time against
 * these ports, so every step is testable without a browser and a screen is
 * only a form over a function.
 *
 * Nothing here is a network. Packets travel by hand (`../packets.ts`).
 */

import type { Json } from "../canonical.js";
import type { Ceremony } from "../ceremony.js";
import type { CircleState, HeldRecord } from "../records.js";
import type { SignedPolicy } from "../types.js";

/** A refusal a screen can word: `code` is stable, `message` is for the tray. */
export class DeskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeskError";
  }
}

/** A circle the owner keeps: the signed policy and the key that signs for it. */
export type OwnedRecord = Readonly<{
  signedPolicy: SignedPolicy;
  /** Never leaves the vault, never in component state past a ceremony step. */
  ownerSecretKey: Uint8Array;
  state: CircleState;
}>;

/**
 * Ceremonies in flight: an invitation waiting for answers, a pending
 * enrollment, a recovery gathering approvals. Sealed per vault (ADR 0149), and
 * plain JSON; any secret inside is base64url and is removed when the ceremony
 * ends.
 */
export type PendingStore = Readonly<{
  read(key: string): Promise<Json | undefined>;
  write(key: string, value: Json): Promise<void>;
  remove(key: string): Promise<void>;
  /** Keys that start with `prefix`. */
  list(prefix: string): Promise<readonly string[]>;
}>;

/** The durable records: circles the person owns and shares they hold for others. */
export type RecordStore = Readonly<{
  owned(): Promise<readonly OwnedRecord[]>;
  saveOwned(record: OwnedRecord): Promise<void>;
  removeOwned(circleId: string): Promise<void>;
  held(): Promise<readonly HeldRecord[]>;
  saveHeld(record: HeldRecord): Promise<void>;
  removeHeld(circleId: string): Promise<void>;
}>;

export type DeskPorts = Readonly<{
  now(): Date;
  /** The page's origin, and the RP ID credentials are registered under. */
  origin: string;
  rpId: string;
  ceremony: Ceremony;
  pending: PendingStore;
  records: RecordStore;
  /** The open vault, where a quorum-approved share is written. */
  tomb: string;
}>;
