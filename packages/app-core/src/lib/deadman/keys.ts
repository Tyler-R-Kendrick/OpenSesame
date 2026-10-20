/**
 * Deadman switch storage names (ADR 0209).
 *
 * The public state and the sealed package are device-local KV records: they
 * never enter a vault body, a sync snapshot or a backup target. The private
 * signing key and the relay token are a sealed VFS file inside one tomb, so
 * they exist only while that vault is open on this device.
 */

export const DEADMAN_STATE_PREFIX = "deadman.state.v1:";
export const DEADMAN_PACKAGE_PREFIX = "deadman.package.v1:";
export const DEADMAN_CONFIG_PATH = "config/deadman";

/** The longest inactivity window the switch accepts, in days. */
export const DEADMAN_MAX_TIMEOUT_DAYS = 3650;
/** The most items one release package may carry. */
export const DEADMAN_MAX_ITEMS = 200;
/** A package is a snapshot, not a vault export; refuse anything larger. */
export const DEADMAN_MAX_PACKAGE_BYTES = 2_000_000;

export function deadmanStateKey(tomb: string): string {
  return `${DEADMAN_STATE_PREFIX}${tomb}`;
}

export function deadmanPackageKey(tomb: string): string {
  return `${DEADMAN_PACKAGE_PREFIX}${tomb}`;
}

/** Keys a cold boot must hydrate for the active tomb, before any unlock. */
export function deadmanBootKeys(tomb: string): readonly string[] {
  return [deadmanStateKey(tomb), deadmanPackageKey(tomb)];
}
