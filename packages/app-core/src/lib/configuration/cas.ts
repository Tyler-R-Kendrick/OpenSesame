import type { BoundaryValue } from "@opensesame/os-domain";
import { type ConfigDraft, draftMatchesScope } from "./draft.js";
import type { CommitResult } from "./types.js";

export type CoupledRecord = {
  resourceKey: string;
  semanticRevision: string;
  sourceRevision: string;
  source: string;
  semantic: BoundaryValue;
  orphanSource: string | null;
  generation: number;
};

export type CoupledChange = {
  resourceKey: string;
  generation: number;
  baseSemanticRevision: string;
  source: string;
  semantic: BoundaryValue;
  presentationOnly: boolean;
  actorKey: string;
  scopeKey: string;
};

export type CoupledIo = {
  writeSource: (source: string) => Promise<void>;
  writeSemantic: (semantic: BoundaryValue) => Promise<void>;
};

export function beginCoupledChange(record: CoupledRecord): number {
  record.generation += 1;
  return record.generation;
}

function refuse(message: string): CommitResult {
  return { status: "refused", message };
}

function conflict(local: string, current: string): CommitResult {
  return {
    status: "conflict",
    message: "This document changed in another session.",
    localSource: local,
    currentSource: current,
  };
}

/**
 * Compare-and-swap with source/semantic coupling. A source blob that lands
 * without a matching semantic commit is an orphan, never shown as applied.
 */
export async function commitCoupledChange(
  record: CoupledRecord,
  change: CoupledChange,
  io: CoupledIo,
  draft: ConfigDraft,
): Promise<CommitResult> {
  if (change.resourceKey !== record.resourceKey) {
    return refuse("Commit is not bound to this resource.");
  }
  if (change.generation !== record.generation) {
    return refuse("Stale save ignored; a newer attempt owns this resource.");
  }
  if (
    !draftMatchesScope(
      draft,
      change.actorKey,
      change.scopeKey,
      change.resourceKey,
    )
  ) {
    return refuse("Scope changed; draft was not applied.");
  }
  if (change.baseSemanticRevision !== record.semanticRevision) {
    return conflict(change.source, record.source);
  }
  try {
    await io.writeSource(change.source);
  } catch (caught) {
    return refuse(
      caught instanceof Error ? caught.message : "Source was not stored.",
    );
  }
  if (change.presentationOnly) {
    record.source = change.source;
    record.sourceRevision = `${record.sourceRevision}+src`;
    record.orphanSource = null;
    return {
      status: "applied_durable",
      revisionToken: record.semanticRevision,
      message: "Saved source comments. Vault access was not changed.",
    };
  }
  try {
    await io.writeSemantic(change.semantic);
  } catch (caught) {
    record.orphanSource = change.source;
    return refuse(
      caught instanceof Error
        ? caught.message
        : "Semantic commit failed after source write.",
    );
  }
  record.source = change.source;
  record.semantic = change.semantic;
  record.semanticRevision = `${record.semanticRevision}+1`;
  record.sourceRevision = record.semanticRevision;
  record.orphanSource = null;
  return {
    status: "applied_durable",
    revisionToken: record.semanticRevision,
    message: "Preferences saved.",
  };
}

export function displayedSource(record: CoupledRecord): string {
  return record.source;
}
