/**
 * The import sheet's state machine (`vault.interop-formats`, ADR 0052 §6):
 * a file the person picked with the vault's Import key is read, recognised,
 * opened when it is an encrypted database, previewed, and merged under one
 * explicit action. Pure over the pipeline in `lib/vault/import/` and a store
 * port — no React, no DOM — so any shell drives the same ordering.
 *
 * A KDBX master password is an argument to one parse and is never held in a
 * stage. An OpenSesame backup (`sealed`) skips the preview: its items stay
 * sealed until the store's own `importSealed` opens them.
 * A store path manifest (`manifest`) merges by path (ADR 0037 §6).
 */
import { overlapCast } from "@opensesame/os-domain";
import type { PasskeyUnlockRecord, VaultHeader } from "@opensesame/vault-core";
import {
  type ParseResult,
  type SourceId,
  parseImportAsync,
  readImportFile,
} from "../../../lib/vault/import/index.js";
import type { MergePlan } from "../../../lib/vault/import/merge.js";
import type { DetectInput } from "../../../lib/vault/import/types.js";
import {
  sealedVaultText,
  vaultFileFormat,
} from "../../../lib/vault/offline-backup-file.js";
import type {
  ManifestMergePlan,
  StorePlainEntry,
} from "../../../lib/vault/store-sync.js";
import {
  getPasskeyUnlockCeremony,
  unwrapVaultKeyWithPrf,
} from "../../../lib/vault/unlock-methods.js";
import { readStoreManifest } from "./store-manifest.js";

export type ImportStage =
  | { step: "reading"; fileName: string }
  /** Could not be read at all — too large, empty, an archive we cannot open. */
  | { step: "unreadable"; fileName: string }
  /** Read fine, but no adapter claimed it; kept so a format can be named. */
  | { step: "failed"; fileName: string; file: DetectInput }
  /** An encrypted database, not opened yet. The bytes wait in `file`. */
  | {
      step: "locked";
      fileName: string;
      file: DetectInput;
      source: SourceId;
      note: string;
    }
  /** An OpenSesame backup or sealed export, restored with its password. */
  | { step: "sealed"; fileName: string; sealed: string }
  /** A store path manifest from Pages or a `pass` store, merged by path. */
  | { step: "manifest"; fileName: string; entries: StorePlainEntry[] }
  | {
      step: "preview";
      fileName: string;
      file: DetectInput;
      result: ParseResult;
    }
  | {
      step: "done";
      fileName: string;
      added: number;
      skipped: number;
      restored: boolean;
      /** Items a manifest rewrote in place, at their own paths. */
      updated?: number;
    };

/** A transition's answer: where the sheet is now, and what went wrong. */
export type StageOutcome = Readonly<{
  stage: ImportStage;
  error: string | null;
}>;

/** What the sheet asks of the vault store. */
export type ImportStorePort = Readonly<{
  applyImport: (plan: MergePlan) => Promise<number>;
  importSealed: (
    fileText: string,
    secret: string | Uint8Array,
  ) => Promise<number>;
  applyManifestMerge: (plan: ManifestMergePlan) => Promise<void>;
}>;

export const importModelSeams = {
  readImportFile,
  parseImportAsync,
  getPasskeyUnlockCeremony,
  unwrapVaultKeyWithPrf,
};

export function messageFrom<Thrown>(caught: Thrown): string {
  return caught instanceof Error && caught.message !== ""
    ? caught.message
    : "That file could not be read.";
}

/** A parse either previews or asks for the password to the blob it was given. */
export function stageFor(
  fileName: string,
  file: DetectInput,
  parsed: ParseResult,
): ImportStage {
  if (parsed.needsPassword === true) {
    return {
      step: "locked",
      fileName,
      file,
      source: parsed.source,
      note: parsed.warnings[0] ?? "",
    };
  }
  return { step: "preview", fileName, file, result: parsed };
}

/**
 * Read a picked file to its first stage. A file that cannot even be read
 * has nothing to offer a format for; one that reads but is not recognised
 * keeps its bytes so the person can name the format.
 */
export async function readStage(file: File): Promise<StageOutcome> {
  let input: DetectInput;
  try {
    input = await importModelSeams.readImportFile(file);
  } catch (caught) {
    return {
      stage: { step: "unreadable", fileName: file.name },
      error: messageFrom(caught),
    };
  }
  if (vaultFileFormat(input.json) !== null) {
    try {
      const sealed = sealedVaultText(input.text);
      return {
        stage: { step: "sealed", fileName: file.name, sealed },
        error: null,
      };
    } catch (caught) {
      return {
        stage: { step: "failed", fileName: file.name, file: input },
        error: messageFrom(caught),
      };
    }
  }
  const entries = readStoreManifest(input.json);
  if (entries !== null) {
    return {
      stage: { step: "manifest", fileName: file.name, entries },
      error: null,
    };
  }
  try {
    const parsed = await importModelSeams.parseImportAsync(input);
    return { stage: stageFor(file.name, input, parsed), error: null };
  } catch (caught) {
    return {
      stage: { step: "failed", fileName: file.name, file: input },
      error: messageFrom(caught),
    };
  }
}

/** Re-read the file in hand as the format the person named. */
export async function reparseStage(
  stage: ImportStage,
  source: SourceId,
): Promise<StageOutcome> {
  if (
    stage.step !== "preview" &&
    stage.step !== "failed" &&
    stage.step !== "locked"
  ) {
    return { stage, error: null };
  }
  try {
    const parsed = await importModelSeams.parseImportAsync(stage.file, source);
    return { stage: stageFor(stage.fileName, stage.file, parsed), error: null };
  } catch (caught) {
    return { stage, error: messageFrom(caught) };
  }
}

/** Decrypt the database in hand with a password used for this parse alone. */
export async function unlockStage(
  stage: ImportStage,
  password: string,
): Promise<StageOutcome> {
  if (stage.step !== "locked" || password === "") return { stage, error: null };
  try {
    const parsed = await importModelSeams.parseImportAsync(
      { ...stage.file, password },
      stage.source,
    );
    return { stage: stageFor(stage.fileName, stage.file, parsed), error: null };
  } catch (caught) {
    return { stage, error: messageFrom(caught) };
  }
}

/** Seal the reviewed plan into the vault in one mutation. */
export async function confirmStage(
  stage: ImportStage,
  plan: MergePlan,
  store: ImportStorePort,
): Promise<StageOutcome> {
  if (stage.step !== "preview" || plan.items.length === 0) {
    return { stage, error: null };
  }
  try {
    const added = await store.applyImport(plan);
    return {
      stage: {
        step: "done",
        fileName: stage.fileName,
        added,
        skipped: plan.duplicates.length,
        restored: false,
      },
      error: null,
    };
  } catch (caught) {
    return { stage, error: messageFrom(caught) };
  }
}

function passkeyRecord(sealed: string): PasskeyUnlockRecord {
  const parsed = overlapCast<unknown, { header?: VaultHeader }>(
    JSON.parse(sealed),
  );
  const record =
    parsed.header?.unlocks?.passkey ?? parsed.header?.unlocks?.passkeys?.[0];
  if (!record) throw new Error("This backup opens with its passkey.");
  return record;
}

function restored(
  stage: ImportStage & { step: "sealed" },
  added: number,
): StageOutcome {
  return {
    stage: {
      step: "done",
      fileName: stage.fileName,
      added,
      skipped: 0,
      restored: true,
    },
    error: null,
  };
}

/** Restore an OpenSesame backup's items not already in this vault. */
export async function restoreStage(
  stage: ImportStage,
  password: string,
  store: ImportStorePort,
): Promise<StageOutcome> {
  if (stage.step !== "sealed" || password === "") return { stage, error: null };
  try {
    return restored(stage, await store.importSealed(stage.sealed, password));
  } catch (caught) {
    return { stage, error: messageFrom(caught) };
  }
}

/** Restore a passkey backup: the ceremony unwraps the key, then the store merges. */
export async function restoreWithPasskey(
  stage: ImportStage,
  store: ImportStorePort,
): Promise<StageOutcome> {
  if (stage.step !== "sealed") return { stage, error: null };
  try {
    const record = passkeyRecord(stage.sealed);
    const prf = await importModelSeams.getPasskeyUnlockCeremony(record);
    const raw = await importModelSeams.unwrapVaultKeyWithPrf(record, prf);
    try {
      return restored(stage, await store.importSealed(stage.sealed, raw));
    } finally {
      raw.fill(0);
    }
  } catch (caught) {
    return { stage, error: messageFrom(caught) };
  }
}

/** Merge a store path manifest by path: adds, in-place updates, one write. */
export async function confirmManifestStage(
  stage: ImportStage,
  plan: ManifestMergePlan,
  store: ImportStorePort,
): Promise<StageOutcome> {
  if (stage.step !== "manifest") return { stage, error: null };
  try {
    await store.applyManifestMerge(plan);
    return {
      stage: {
        step: "done",
        fileName: stage.fileName,
        added: plan.adds.length,
        skipped: plan.unchanged,
        restored: false,
        updated: plan.updates.length,
      },
      error: null,
    };
  } catch (caught) {
    return { stage, error: messageFrom(caught) };
  }
}
