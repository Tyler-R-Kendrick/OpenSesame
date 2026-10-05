/**
 * The duress journals' key names, and the keys a cold load must hydrate for
 * them. No imports, on purpose: the bootstrap reads this file, and a leaf with
 * nothing behind it adds nothing to what loads before the first paint.
 *
 * Reading a journal is synchronous, so a key that is not in the KV cache reads
 * as absent. The enrollment is the armed code: if it is not hydrated, the code
 * typed at the unlock screen matches nothing after a reload, with no error.
 */

export const ENROLLMENT_STATE_KEY = "duress.enrollment-state.v1";
export const INCIDENT_INTENT_KEY = "duress.incident-intent.v1";
export const INCIDENT_RECORD_KEY = "duress.incident-record.v1";
/** The hold a freeze code leaves: read at every unlock, before any vault opens. */
export const HOLD_KEY = "duress.hold.v1";

/** Where a journal stages a write before its commit marker is set. */
export function stagingKeyOf(key: string): string {
  return `${key}.__staging`;
}

/** The marker that says a staged write is the one to promote. */
export function commitKeyOf(key: string): string {
  return `${key}.__commit`;
}

/** Every stored key one journal can be read from. */
export function journalKeysOf(key: string): readonly string[] {
  return [key, stagingKeyOf(key), commitKeyOf(key)];
}

/**
 * What the core boot hydrates for duress: the armed code, and the incident
 * journals that hold the device fenced across a restart.
 */
export const DURESS_BOOT_KEYS: readonly string[] = [
  ENROLLMENT_STATE_KEY,
  INCIDENT_INTENT_KEY,
  INCIDENT_RECORD_KEY,
  HOLD_KEY,
].flatMap(journalKeysOf);
