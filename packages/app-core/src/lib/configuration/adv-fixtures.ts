import type { CoupledRecord } from "./cas.js";
import { createDraft } from "./draft.js";
import { prefsToYaml } from "./prefs-document.js";
import { PREFS_RESOURCE_KEY } from "./prefs-keys.js";

export const PREFS = {
  theme: "system" as const,
  autoLockMinutes: 0,
  lockOnHide: false,
  signOutOnLock: false,
  clipboardClearSeconds: 30,
};

export const COMMENTED = `# keep
theme: system
autoLockMinutes: 0
lockOnHide: false
signOutOnLock: false
clipboardClearSeconds: 30
`;

export function draft(source = COMMENTED) {
  return createDraft({
    resourceKey: PREFS_RESOURCE_KEY,
    revisionToken: "r1",
    source,
    actorKey: "actor-a",
    scopeKey: "tomb:personal",
  });
}

export function record(source = prefsToYaml(PREFS)): CoupledRecord {
  return {
    resourceKey: PREFS_RESOURCE_KEY,
    semanticRevision: "r1",
    sourceRevision: "r1",
    source,
    semantic: PREFS,
    orphanSource: null,
    generation: 0,
  };
}
