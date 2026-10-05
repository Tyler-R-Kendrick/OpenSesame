import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DURESS_BOOT_KEYS,
  ENROLLMENT_STATE_KEY,
  INCIDENT_INTENT_KEY,
  INCIDENT_RECORD_KEY,
  commitKeyOf,
  journalKeysOf,
  stagingKeyOf,
} from "./boot-keys.js";
import { clearJournal, journalSeams, writeJournal } from "./journal.js";

// Every key the journal writes, recorded at its own seam and passed through.
const written = new Set<string>();
const real = { ...journalSeams };
beforeEach(() => {
  journalSeams.set = (key, value) => {
    written.add(key);
    real.set(key, value);
  };
  journalSeams.setDurable = async (key, value) => {
    written.add(key);
    await real.setDurable(key, value);
  };
});
afterEach(() => Object.assign(journalSeams, real));

describe("duress boot keys", () => {
  it("name every key a journal can be read from, for each journal", () => {
    for (const key of [
      ENROLLMENT_STATE_KEY,
      INCIDENT_INTENT_KEY,
      INCIDENT_RECORD_KEY,
    ]) {
      expect(journalKeysOf(key)).toEqual([
        key,
        stagingKeyOf(key),
        commitKeyOf(key),
      ]);
      for (const stored of journalKeysOf(key)) {
        expect(DURESS_BOOT_KEYS).toContain(stored);
      }
    }
  });

  it("cover every key the journal writes, so a cold load reads the armed code", async () => {
    // A key a journal writes but the boot never hydrates reads as absent after
    // a reload: the armed code silently matches nothing at the unlock screen.
    for (const key of [
      ENROLLMENT_STATE_KEY,
      INCIDENT_INTENT_KEY,
      INCIDENT_RECORD_KEY,
    ]) {
      written.clear();
      await writeJournal(key, { probe: true });
      expect(written.size).toBeGreaterThan(0);
      for (const stored of written) {
        expect(DURESS_BOOT_KEYS).toContain(stored);
      }
      clearJournal(key);
    }
  });
});
