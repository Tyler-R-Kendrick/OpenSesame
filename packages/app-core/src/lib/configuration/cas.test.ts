import { describe, expect, it } from "vitest";
import {
  type CoupledRecord,
  beginCoupledChange,
  commitCoupledChange,
  displayedSource,
} from "./cas.js";
import { createDraft } from "./draft.js";
import { prefsToYaml } from "./prefs-document.js";
import { isPresentationOnlyChange } from "./yaml-patch.js";

const PREFS = {
  theme: "system" as const,
  autoLockMinutes: 0,
  lockOnHide: false,
  signOutOnLock: false,
  clipboardClearSeconds: 30,
};

function record(): CoupledRecord {
  const source = prefsToYaml(PREFS);
  return {
    resourceKey: "client_local:vault:prefs",
    semanticRevision: "r1",
    sourceRevision: "r1",
    source,
    semantic: PREFS,
    orphanSource: null,
    generation: 0,
  };
}

function draftFor(source: string) {
  return createDraft({
    resourceKey: "client_local:vault:prefs",
    revisionToken: "r1",
    source,
    actorKey: "actor-a",
    scopeKey: "tomb:personal",
  });
}

describe("coupled CAS commits", () => {
  it("conflicts when two tabs share a base revision (ADV-06)", async () => {
    const state = record();
    const gen1 = beginCoupledChange(state);
    const first = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation: gen1,
        baseSemanticRevision: "r1",
        source: prefsToYaml({ ...PREFS, theme: "dark" }),
        semantic: { ...PREFS, theme: "dark" },
        presentationOnly: false,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => undefined,
      },
      draftFor(state.source),
    );
    expect(first.status).toBe("applied_durable");
    const gen2 = beginCoupledChange(state);
    const second = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation: gen2,
        baseSemanticRevision: "r1",
        source: `${state.source}# comment\n`,
        semantic: PREFS,
        presentationOnly: true,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => {
          throw new Error("must not write semantic");
        },
      },
      draftFor(state.source),
    );
    expect(second.status).toBe("conflict");
    expect(state.semantic).toEqual({ ...PREFS, theme: "dark" });
  });

  it("keeps prior semantic when source writes and semantic fails (ADV-08)", async () => {
    const state = record();
    const generation = beginCoupledChange(state);
    const nextSource = prefsToYaml({ ...PREFS, theme: "dark" });
    const result = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation,
        baseSemanticRevision: "r1",
        source: nextSource,
        semantic: { ...PREFS, theme: "dark" },
        presentationOnly: false,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => {
          throw new Error("disk full");
        },
      },
      draftFor(state.source),
    );
    expect(result.status).toBe("refused");
    expect(result.message).toContain("disk full");
    expect(state.semantic).toEqual(PREFS);
    expect(state.orphanSource).toBe(nextSource);
    expect(displayedSource(state)).toBe(prefsToYaml(PREFS));
  });

  it("ignores a stale generation after a newer save (ADV-28)", async () => {
    const state = record();
    const stale = beginCoupledChange(state);
    const fresh = beginCoupledChange(state);
    const staleResult = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation: stale,
        baseSemanticRevision: "r1",
        source: prefsToYaml({ ...PREFS, theme: "dark" }),
        semantic: { ...PREFS, theme: "dark" },
        presentationOnly: false,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => undefined,
      },
      draftFor(state.source),
    );
    expect(staleResult.status).toBe("refused");
    expect(staleResult.message).toContain("Stale save");
    const freshResult = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation: fresh,
        baseSemanticRevision: "r1",
        source: prefsToYaml({ ...PREFS, autoLockMinutes: 7 }),
        semantic: { ...PREFS, autoLockMinutes: 7 },
        presentationOnly: false,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => undefined,
      },
      draftFor(state.source),
    );
    expect(freshResult.status).toBe("applied_durable");
    expect(freshResult.revisionToken).not.toBe("r1");
  });

  it("does not apply across tomb scope (ADV-07)", async () => {
    const state = record();
    const generation = beginCoupledChange(state);
    const result = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation,
        baseSemanticRevision: "r1",
        source: prefsToYaml({ ...PREFS, theme: "dark" }),
        semantic: { ...PREFS, theme: "dark" },
        presentationOnly: false,
        actorKey: "actor-a",
        scopeKey: "tomb:other",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => undefined,
      },
      draftFor(state.source),
    );
    expect(result.status).toBe("refused");
    expect(state.semantic).toEqual(PREFS);
  });

  it("comment-only writes skip semantic mutation", async () => {
    const state = record();
    const commented = `${state.source}# keep\n`;
    expect(isPresentationOnlyChange(state.source, commented)).toBe(true);
    const generation = beginCoupledChange(state);
    const result = await commitCoupledChange(
      state,
      {
        resourceKey: state.resourceKey,
        generation,
        baseSemanticRevision: "r1",
        source: commented,
        semantic: PREFS,
        presentationOnly: true,
        actorKey: "actor-a",
        scopeKey: "tomb:personal",
      },
      {
        writeSource: async () => undefined,
        writeSemantic: async () => {
          throw new Error("semantic must not run");
        },
      },
      draftFor(state.source),
    );
    expect(result.status).toBe("applied_durable");
    expect(result.revisionToken).toBe("r1");
    expect(state.source).toBe(commented);
  });
});
