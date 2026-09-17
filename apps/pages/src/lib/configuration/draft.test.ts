import { describe, expect, it } from "vitest";
import {
  applySourceEdit,
  createDraft,
  draftMatchesScope,
  switchDraftMode,
  undoDraft,
} from "./draft.js";
import { patchYamlTopLevel } from "./yaml-patch.js";

const SOURCE = `# note
theme: system
autoLockMinutes: 0
`;

describe("draft lifecycle", () => {
  it("keeps exact bytes when switching Visual/Source with no edit", () => {
    const draft = createDraft({
      resourceKey: "client_local:vault:prefs",
      revisionToken: "1",
      source: SOURCE,
      actorKey: "actor-a",
      scopeKey: "tomb:personal",
    });
    const switched = switchDraftMode(draft, "source");
    expect(switched.currentSource).toBe(SOURCE);
    expect(switched.originalSource).toBe(SOURCE);
  });

  it("preserves comments through a visual field patch and undo", () => {
    const draft = createDraft({
      resourceKey: "client_local:vault:prefs",
      revisionToken: "1",
      source: SOURCE,
      actorKey: "actor-a",
      scopeKey: "tomb:personal",
    });
    const patched = patchYamlTopLevel(
      draft.currentSource,
      "autoLockMinutes",
      7,
    );
    const edited = applySourceEdit(draft, patched, []);
    expect(edited.currentSource).toContain("# note");
    expect(edited.currentSource).toContain("autoLockMinutes: 7");
    const undone = undoDraft(edited);
    expect(undone.currentSource).toBe(SOURCE);
  });

  it("refuses to apply a draft into another tomb or resource", () => {
    const draft = createDraft({
      resourceKey: "client_local:vault:prefs",
      revisionToken: "1",
      source: SOURCE,
      actorKey: "actor-a",
      scopeKey: "tomb:personal",
    });
    expect(
      draftMatchesScope(draft, "actor-a", "tomb:other", draft.resourceKey),
    ).toBe(false);
    expect(
      draftMatchesScope(draft, "actor-b", "tomb:personal", draft.resourceKey),
    ).toBe(false);
  });
});
