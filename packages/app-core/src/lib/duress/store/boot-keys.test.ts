import { describe, expect, it, vi } from "vitest";

const written = vi.hoisted(() => new Set<string>());

vi.mock("../../kv.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../kv.js")>();
  return {
    ...real,
    kvSet: (key: string, value: string) => {
      written.add(key);
      return real.kvSet(key, value);
    },
  };
});

import {
  DURESS_BOOT_KEYS,
  ENROLLMENT_STATE_KEY,
  INCIDENT_INTENT_KEY,
  INCIDENT_RECORD_KEY,
  commitKeyOf,
  journalKeysOf,
  stagingKeyOf,
} from "./boot-keys.js";
import { clearJournal, writeJournal } from "./journal.js";

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
