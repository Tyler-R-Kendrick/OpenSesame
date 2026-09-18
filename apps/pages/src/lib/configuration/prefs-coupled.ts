import {
  type CoupledRecord,
  beginCoupledChange,
  commitCoupledChange,
} from "./cas.js";
import type { ConfigDraft } from "./draft.js";
import { parsePrefsSource, prefsToYaml } from "./prefs-document.js";
import type { PrefsDocument } from "./prefs-document.js";
import type { CommitResult } from "./types.js";
import { isPresentationOnlyChange } from "./yaml-patch.js";

export async function commitPrefsCoupled(input: {
  record: CoupledRecord;
  draft: ConfigDraft;
  source: string;
  actorKey: string;
  scopeKey: string;
  writeSource: (source: string) => Promise<void>;
  writeSemantic: (prefs: PrefsDocument) => Promise<void>;
}): Promise<CommitResult> {
  const parsed = parsePrefsSource(input.source);
  if (!parsed.ok) {
    return {
      status: "refused",
      message:
        parsed.diagnostics[0]?.message ?? "Invalid preferences document.",
    };
  }
  const previous = prefsToYaml(
    input.record.semantic as {
      theme: PrefsDocument["theme"];
      autoLockMinutes: number;
      lockOnHide: boolean;
      signOutOnLock: boolean;
      clipboardClearSeconds: number;
    },
  );
  const generation = beginCoupledChange(input.record);
  return commitCoupledChange(
    input.record,
    {
      resourceKey: input.record.resourceKey,
      generation,
      baseSemanticRevision: input.record.semanticRevision,
      source: input.source,
      semantic: parsed.value,
      presentationOnly: isPresentationOnlyChange(previous, input.source),
      actorKey: input.actorKey,
      scopeKey: input.scopeKey,
    },
    {
      writeSource: input.writeSource,
      writeSemantic: () => input.writeSemantic(parsed.value),
    },
    input.draft,
  );
}
