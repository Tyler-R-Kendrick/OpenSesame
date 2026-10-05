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

import { DURESS_BOOT_KEYS, WIPE_INTENT_KEY } from "../store/boot-keys.js";
import { clearWipeIntent, writeWipeIntent } from "./intent.js";

describe("the wipe intent and the boot hydrate", () => {
  it("is hydrated by the core boot, every key it is read from", async () => {
    // Journal reads are synchronous: a key the boot does not hydrate reads as
    // absent after a reload, and an interrupted wipe would never resume.
    written.clear();
    expect(await writeWipeIntent(["personal"], new Date())).toBe(true);
    expect(written.size).toBeGreaterThan(0);
    for (const stored of written) expect(DURESS_BOOT_KEYS).toContain(stored);
    expect(DURESS_BOOT_KEYS).toContain(WIPE_INTENT_KEY);
    await clearWipeIntent();
  });
});
