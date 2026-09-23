import type { JsonObject } from "@opensesame/os-domain";
import type { ConfigDiagnostic } from "./types.js";

export type EditorMode = "visual" | "source";

export type ConfigDraft = {
  resourceKey: string;
  revisionToken: string;
  mode: EditorMode;
  originalSource: string;
  currentSource: string;
  lastValid: JsonObject | null;
  diagnostics: ConfigDiagnostic[];
  history: string[];
  historyIndex: number;
  actorKey: string;
  scopeKey: string;
};

export function createDraft(input: {
  resourceKey: string;
  revisionToken: string;
  source: string;
  actorKey: string;
  scopeKey: string;
  lastValid?: JsonObject | null;
}): ConfigDraft {
  return {
    resourceKey: input.resourceKey,
    revisionToken: input.revisionToken,
    mode: "visual",
    originalSource: input.source,
    currentSource: input.source,
    lastValid: input.lastValid ?? null,
    diagnostics: [],
    history: [input.source],
    historyIndex: 0,
    actorKey: input.actorKey,
    scopeKey: input.scopeKey,
  };
}

/** Mode switch with no edit must keep exact bytes. */
export function switchDraftMode(
  draft: ConfigDraft,
  mode: EditorMode,
): ConfigDraft {
  return { ...draft, mode };
}

function pushHistory(draft: ConfigDraft, source: string): ConfigDraft {
  const history = draft.history.slice(0, draft.historyIndex + 1);
  history.push(source);
  return {
    ...draft,
    currentSource: source,
    history,
    historyIndex: history.length - 1,
  };
}

export function applySourceEdit(
  draft: ConfigDraft,
  source: string,
  diagnostics: ConfigDiagnostic[],
  lastValid?: JsonObject | null,
): ConfigDraft {
  const next = pushHistory(draft, source);
  return {
    ...next,
    diagnostics,
    lastValid: lastValid === undefined ? draft.lastValid : lastValid,
  };
}

export function undoDraft(draft: ConfigDraft): ConfigDraft {
  if (draft.historyIndex <= 0) return draft;
  const historyIndex = draft.historyIndex - 1;
  return {
    ...draft,
    historyIndex,
    currentSource: draft.history[historyIndex] ?? draft.currentSource,
  };
}

export function redoDraft(draft: ConfigDraft): ConfigDraft {
  if (draft.historyIndex >= draft.history.length - 1) return draft;
  const historyIndex = draft.historyIndex + 1;
  return {
    ...draft,
    historyIndex,
    currentSource: draft.history[historyIndex] ?? draft.currentSource,
  };
}

export function draftIsDirty(draft: ConfigDraft): boolean {
  return draft.currentSource !== draft.originalSource;
}

export function draftMatchesScope(
  draft: ConfigDraft,
  actorKey: string,
  scopeKey: string,
  resourceKey: string,
): boolean {
  return (
    draft.actorKey === actorKey &&
    draft.scopeKey === scopeKey &&
    draft.resourceKey === resourceKey
  );
}
