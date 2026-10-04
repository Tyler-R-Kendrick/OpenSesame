/**
 * The seam between the device identity key and the vault body that carries it
 * (ADR 0160 §5).
 *
 * The key is a tomb file the device host reads, and a copy rides in the sealed
 * body so it travels with the vault. The host cannot import the vault store
 * (the store sits on its import cycle), so the store installs itself here when
 * it loads and the key reads and writes the body through this port. With no
 * store installed (a unit test of the key alone) the port holds nothing and
 * accepts nothing, which is the behaviour before the key travelled.
 *
 * Both calls name the tomb: a store answers only for the tomb it has open, so
 * a key never lands in another vault's body.
 */

import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";

export type DeviceKeyCarrier = {
  /** The body's key field for `tomb` while that vault is open here, else undefined. */
  /** What the body holds under the key's name: unvetted JSON, whatever it is. */
  carried(tomb: string): BoundaryValue;
  /**
   * Put `field` in the body of `tomb`, ranked against what it already carries
   * (`mergeDeviceKeyFields`), and persist. A no-op unless `tomb` is open here.
   */
  publish(tomb: string, field: JsonObject): Promise<void>;
};

export const deviceKeyCarrier: DeviceKeyCarrier = {
  carried: () => undefined,
  publish: () => Promise.resolve(),
};
