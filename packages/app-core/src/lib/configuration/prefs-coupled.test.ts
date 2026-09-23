import { describe, expect, it } from "vitest";
import type { CoupledRecord } from "./cas.js";
import { createDraft } from "./draft.js";
import { commitPrefsCoupled } from "./prefs-coupled.js";
import { prefsToYaml } from "./prefs-document.js";

const PREFS = {
  theme: "system" as const,
  autoLockMinutes: 0,
  lockOnHide: false,
  signOutOnLock: false,
  clipboardClearSeconds: 30,
};

describe("commitPrefsCoupled", () => {
  it("uses CAS so a failed semantic write is not durable", async () => {
    const source = prefsToYaml(PREFS);
    const record: CoupledRecord = {
      resourceKey: "client_local:vault:prefs",
      semanticRevision: "r1",
      sourceRevision: "r1",
      source,
      semantic: PREFS,
      orphanSource: null,
      generation: 0,
    };
    const result = await commitPrefsCoupled({
      record,
      draft: createDraft({
        resourceKey: record.resourceKey,
        revisionToken: "r1",
        source,
        actorKey: "a",
        scopeKey: "tomb:personal",
      }),
      source: prefsToYaml({ ...PREFS, theme: "dark" }),
      actorKey: "a",
      scopeKey: "tomb:personal",
      writeSource: async () => undefined,
      writeSemantic: async () => {
        throw new Error("quota");
      },
    });
    expect(result.status).toBe("refused");
    expect(record.semantic).toEqual(PREFS);
    expect(record.orphanSource).toContain("theme: dark");
  });
});
