import { describe, expect, it } from "vitest";
import type { VaultPrefs } from "../vault/store.js";
import { type PrefsPorts, commitPrefsSource } from "./prefs-adapter.js";
import { prefsToYaml } from "./prefs-document.js";

function prefs(partial: Partial<VaultPrefs> = {}): VaultPrefs {
  return {
    theme: "system",
    autoLockMinutes: 0,
    lockOnHide: false,
    signOutOnLock: false,
    clipboardClearSeconds: 30,
    prefsRevision: 2,
    ...partial,
  };
}

describe("commitPrefsSource", () => {
  it("reports durable success only after the write resolves", async () => {
    let stored = prefs();
    const ports: PrefsPorts = {
      readPrefs: () => stored,
      tomb: () => "personal",
      revisionToken: () => "rev-1",
      writeSemantic: async (next) => {
        stored = { ...stored, ...next };
      },
    };
    const source = prefsToYaml(prefs({ autoLockMinutes: 7, theme: "dark" }));
    const result = await commitPrefsSource(ports, {
      source,
      baseRevision: "rev-1",
    });
    expect(result.status).toBe("applied_durable");
    expect(stored.autoLockMinutes).toBe(7);
    expect(stored.theme).toBe("dark");
  });

  it("does not claim a durable save when persistence throws", async () => {
    const stored = prefs();
    const ports: PrefsPorts = {
      readPrefs: () => stored,
      tomb: () => "personal",
      revisionToken: () => "rev-1",
      writeSemantic: async () => {
        throw new Error("quota");
      },
    };
    const result = await commitPrefsSource(ports, {
      source: prefsToYaml(prefs({ theme: "dark" })),
      baseRevision: "rev-1",
    });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("quota");
    expect(stored.theme).toBe("system");
  });

  it("returns a conflict when the base revision is stale", async () => {
    const ports: PrefsPorts = {
      readPrefs: () => prefs(),
      tomb: () => "personal",
      revisionToken: () => "rev-2",
      writeSemantic: async () => {
        throw new Error("should not write");
      },
    };
    const result = await commitPrefsSource(ports, {
      source: prefsToYaml(prefs({ theme: "dark" })),
      baseRevision: "rev-1",
    });
    expect(result.status).toBe("conflict");
  });

  it("does not treat a comment-only save as a semantic prefs write", async () => {
    let writes = 0;
    const current = prefsToYaml(prefs());
    const ports: PrefsPorts = {
      readPrefs: () => prefs(),
      tomb: () => "personal",
      revisionToken: () => "rev-1",
      writeSemantic: async () => {
        writes += 1;
      },
      writeSource: async () => undefined,
    };
    const result = await commitPrefsSource(ports, {
      source: `${current}# note\n`,
      baseRevision: "rev-1",
    });
    expect(result.status).toBe("applied_durable");
    expect(writes).toBe(0);
    expect(result.message).toContain("not changed");
  });
});
