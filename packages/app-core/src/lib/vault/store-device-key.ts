/**
 * What the vault store lends so the device identity key can ride in its body
 * (ADR 0160 §5a).
 *
 * Split out of `store.ts`: the store holds the body and its write chain; this
 * file turns that into the two things the key needs, a host to reconcile
 * against at unlock, merge and restore (`device-identity-carry.ts`) and the
 * carrier port the device host mints through (`device-identity-carrier.ts`).
 *
 * The port is not a method of the store, so the store's public surface does
 * not hand out its body: the store registers it here, and the few callers that
 * need it (the carrier, a restore, a test) ask for it by store.
 */

import type { JsonObject } from "@opensesame/os-domain";
import {
  DEVICE_KEY_CLOCK_MARGIN_MS,
  type VaultBody,
  type VaultHeader,
  clampDeviceKeyTime,
  deviceKeyField,
  deviceKeyTimeBounds,
  mergeDeviceKeyFields,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import {
  type DeviceKeyCarrier,
  deviceKeyCarrier,
} from "../device-identity-carrier.js";
import type {
  KeyCarryHost,
  KeyCarryOptions,
  KeyCarryOutcome,
} from "../device-identity-carry.js";
import { loadVaultBody } from "./store-body.js";
import { withBodyWriteLock } from "./vault-shared-locks.js";

/** The open vault, as far as the key and a restore need to see it. */
export type VaultBodyPort = Readonly<{
  tomb: () => string;
  /** The vault key is held, so the body is loaded and can be written. */
  open: () => boolean;
  /** False for a guest or scratch session: nothing there is exported or synced. */
  carries: () => boolean;
  header: () => VaultHeader | null;
  body: () => VaultBody;
  mutate: (change: (body: VaultBody) => void) => Promise<void>;
  /**
   * Change the body under the cross-tab body lock, starting from what the disk
   * holds now: a tab that answered a request from a stale copy never writes
   * over another tab's edit, nor with a revision the header has moved past.
   */
  mutateFresh: (change: (body: VaultBody) => void) => Promise<void>;
  /**
   * Put `field` in the body, from the disk's copy and under the body lock. It
   * is vetted first (what is not a genuine key is never carried) and its date
   * brought inside the vault's window; the body's own key is vetted too (a
   * forged or malformed record is dropped, not outranked) and ranked against
   * it. Nothing is written when that changes nothing, so a read of the
   * principal, or an unlock that finds the key already carried, never costs a
   * sync.
   */
  publishKey: (field: JsonObject) => Promise<void>;
}>;

/** What the store lends `makeBodyPort`: its private state, by closure. */
export type BodyHost = Readonly<{
  tomb: () => string;
  open: () => boolean;
  carries: () => boolean;
  /** The vault key; throws while the vault is locked. */
  vaultKey: () => CryptoKey;
  header: () => VaultHeader | null;
  setHeader: (next: VaultHeader | null) => void;
  readHeader: () => VaultHeader | null;
  body: () => VaultBody;
  setBody: (next: VaultBody) => void;
  emit: () => void;
  flush: () => Promise<void>;
  mutate: (change: (body: VaultBody) => void) => Promise<void>;
}>;

/**
 * Run `act` under the cross-tab body lock with the store's body and header
 * replaced by what the disk holds: another tab may have written since this one
 * loaded, and a write from the stale copy would drop its edit and could seal a
 * revision the header has already moved past.
 */
async function withFreshBody<T>(
  host: BodyHost,
  act: () => Promise<T>,
): Promise<T> {
  const vaultKey = host.vaultKey();
  await host.flush();
  const tomb = host.tomb();
  return withBodyWriteLock(tomb, async () => {
    host.setHeader(host.readHeader() ?? host.header());
    const disk = await loadVaultBody(tomb, vaultKey, host.header());
    if ((disk.rev ?? 0) > (host.body().rev ?? 0)) {
      host.setBody(disk);
      syncInstalledTypes(disk.itemTypes);
      host.emit();
    }
    return act();
  });
}

export function makeBodyPort(host: BodyHost): VaultBodyPort {
  return {
    tomb: host.tomb,
    open: host.open,
    carries: host.carries,
    header: host.header,
    body: host.body,
    mutate: host.mutate,
    mutateFresh: (change) => withFreshBody(host, () => host.mutate(change)),
    publishKey: (field) =>
      withFreshBody(host, async () => {
        const { trustedDeviceKey, vetCarriedKey } = await import(
          "../device-identity-trust.js"
        );
        const bounds = deviceKeyTimeBounds(host.header()?.createdAt);
        // The date is clamped below, so any date the file holds is read here.
        const offered = await trustedDeviceKey(field, {
          now: Number.MAX_SAFE_INTEGER - DEVICE_KEY_CLOCK_MARGIN_MS,
        });
        if (!offered) return;
        const record = clampDeviceKeyTime(offered, bounds);
        const held = host.body().deviceIdentityKey;
        const carried = await vetCarriedKey(held, bounds);
        if (carried.kind === "future") return;
        if (
          carried.kind === "trusted" &&
          carried.record.keyId === record.keyId
        ) {
          return;
        }
        const next = mergeDeviceKeyFields(
          carried.kind === "trusted" ? held : undefined,
          deviceKeyField(record),
        );
        if (next === held) return;
        await host.mutate((body) => {
          body.deviceIdentityKey = next;
        });
      }),
  };
}

/** What a store is, to the registry: it names its tomb. */
export type PortOwner = { activeTomb(): string };

const ports = new WeakMap<PortOwner, () => VaultBodyPort>();

/** The store hands its port to this module once, when it is made. */
export function registerBodyPort(
  owner: PortOwner,
  port: () => VaultBodyPort,
): void {
  ports.set(owner, port);
}

/** The port of a registered store. An internal seam: the store itself offers no body. */
export function bodyPortOf(owner: PortOwner): VaultBodyPort {
  const port = ports.get(owner);
  if (!port) throw new Error("That is not a vault store.");
  return port();
}

export function keyCarryHost(port: VaultBodyPort): KeyCarryHost {
  return {
    tomb: port.tomb(),
    carries: port.open() && port.carries(),
    field: () => port.body().deviceIdentityKey,
    bounds: () => deviceKeyTimeBounds(port.header()?.createdAt),
    publish: (field: JsonObject) => port.publishKey(field),
  };
}

/**
 * Level the tomb's key with the body's. Never throws: a vault that opens or
 * merges must not fail over its identity, and the next unlock tries again.
 */
export async function levelDeviceKey(
  port: VaultBodyPort,
  options: KeyCarryOptions = {},
): Promise<KeyCarryOutcome> {
  try {
    // Loaded when a vault opens, merges or restores, not with the store.
    const { reconcileDeviceIdentityKey } = await import(
      "../device-identity-carry.js"
    );
    return await reconcileDeviceIdentityKey(keyCarryHost(port), options);
  } catch {
    return "kept";
  }
}

/** The carrier for whichever store `port` reads; it answers only for the tomb open there. */
export function installDeviceKeyCarrier(port: () => VaultBodyPort): void {
  const answers = (tomb: string): VaultBodyPort | null => {
    const now = port();
    return now.open() && now.carries() && now.tomb() === tomb ? now : null;
  };
  const carrier: DeviceKeyCarrier = {
    carried: (tomb) => answers(tomb)?.body().deviceIdentityKey,
    bounds: (tomb) => {
      const open = answers(tomb);
      return open ? deviceKeyTimeBounds(open.header()?.createdAt) : {};
    },
    publish: (tomb, field) => {
      const now = answers(tomb);
      return now ? keyCarryHost(now).publish(field) : Promise.resolve();
    },
  };
  Object.assign(deviceKeyCarrier, carrier);
}
