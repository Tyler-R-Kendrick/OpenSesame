/**
 * Crash-consistent recoverable journal over KV/OPFS (STORE-C/F).
 * Staging → commit-marker → primary; recovery promotes staging when primary is gone.
 * Never claims durability when OPFS is absent — callers must read kvDurability().
 */

import {
  kvDelete,
  kvDeleteDurable,
  kvDurability,
  kvGet,
  kvSet,
  kvSetDurable,
} from "../../kv.js";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  overlapCast,
} from "../json-boundary.js";
import { commitKeyOf, stagingKeyOf } from "./boot-keys.js";

export const journalSeams = {
  durability: (): ReturnType<typeof kvDurability> => kvDurability(),
  /** Every key the journal writes passes here or through `setDurable`. */
  set: kvSet,
  setDurable: kvSetDurable,
  deleteDurable: kvDeleteDurable,
};

export type JournalWriteResult =
  | { ok: true; durable: boolean; revision: number }
  | {
      ok: false;
      code:
        | "undurable_storage"
        | "quota_failure"
        | "interrupted_write"
        | "stale_revision";
      message: string;
    };

export type JournalRecord<T> = Readonly<{
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  payload: T;
}>;

const stagingKey = stagingKeyOf;
const commitKey = commitKeyOf;

function parseRecord<T>(raw: string | null): JournalRecord<T> | null {
  if (!raw) return null;
  let wire: BoundaryValue;
  try {
    wire = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(wire)) return null;
  if (wire.schemaVersion !== 1) return null;
  if (!isNumber(wire.revision)) return null;
  if (wire.payload === undefined) return null;
  // SAFETY: wire passed journal envelope checks; payload shape is owned by writeJournal callers.
  return overlapCast<JsonObject, JournalRecord<T>>(wire);
}

/** Recover primary, or promote valid staging after an interrupted commit. */
export function recoverJournal<T>(key: string): JournalRecord<T> | null {
  const primary = parseRecord<T>(kvGet(key));
  const staging = parseRecord<T>(kvGet(stagingKey(key)));
  const commit = kvGet(commitKey(key));

  if (primary && staging) {
    if (
      staging.revision >= primary.revision &&
      commit === String(staging.revision)
    ) {
      journalSeams.set(key, JSON.stringify(staging));
      kvDelete(stagingKey(key));
      kvDelete(commitKey(key));
      return staging;
    }
    return primary;
  }
  if (!primary && staging && commit === String(staging.revision)) {
    journalSeams.set(key, JSON.stringify(staging));
    kvDelete(stagingKey(key));
    kvDelete(commitKey(key));
    return staging;
  }
  if (primary) return primary;
  return null;
}

/**
 * Monotonic journal write. Rejects stale revisions (multi-instance).
 * When `requireDurable` and OPFS is memory-only, fails closed with undurable_storage.
 */
type WriteJournalOptions = Readonly<{
  requireDurable?: boolean;
  expectedRevision?: number | undefined;
  now?: () => string;
}>;
const defaultWriteJournalOptions = {} satisfies WriteJournalOptions;

export async function writeJournal<T>(
  key: string,
  payload: T,
  options: WriteJournalOptions = defaultWriteJournalOptions,
): Promise<JournalWriteResult> {
  const durability = journalSeams.durability();
  if (options.requireDurable && durability !== "persistent") {
    return {
      ok: false,
      code: "undurable_storage",
      message: "Durable local storage is unavailable; refusing journal commit.",
    };
  }

  const existing = recoverJournal<T>(key);
  const nextRevision = (existing?.revision ?? 0) + 1;
  if (
    options.expectedRevision !== undefined &&
    (existing?.revision ?? 0) !== options.expectedRevision
  ) {
    return {
      ok: false,
      code: "stale_revision",
      message: "Journal revision advanced in another instance.",
    };
  }

  const record: JournalRecord<T> = {
    schemaVersion: 1,
    revision: nextRevision,
    updatedAt: (options.now ?? (() => new Date().toISOString()))(),
    payload,
  };
  const body = JSON.stringify(record);

  try {
    return await commitJournalWrite(key, body, nextRevision, durability);
  } catch (error) {
    await dropStaged(key);
    return {
      ok: false,
      code: "interrupted_write",
      message:
        error instanceof Error ? error.message : "interrupted journal write",
    };
  }
}

async function commitJournalWrite(
  key: string,
  body: string,
  nextRevision: number,
  durability: ReturnType<typeof kvDurability>,
): Promise<JournalWriteResult> {
  journalSeams.set(stagingKey(key), body);
  journalSeams.set(commitKey(key), String(nextRevision));
  if (durability === "persistent") {
    const durableFailure = await persistJournalPrimary(key, body);
    if (durableFailure) {
      // The caller is told the write failed, so what it staged must not
      // survive to be promoted by the next read: the code would be live for
      // this session and gone after a reload.
      await dropStaged(key);
      return durableFailure;
    }
  } else {
    journalSeams.set(key, body);
  }
  kvDelete(stagingKey(key));
  kvDelete(commitKey(key));
  return {
    ok: true,
    durable: durability === "persistent",
    revision: nextRevision,
  };
}

/** Forget a staged write, waiting for storage to agree; memory goes either way. */
async function dropStaged(key: string): Promise<void> {
  for (const staged of [stagingKey(key), commitKey(key)]) {
    try {
      await journalSeams.deleteDurable(staged);
    } catch {
      // kvDeleteDurable has already dropped it from memory, which is what
      // reads consult; a file that will not go is reported by the caller's
      // refusal, and recovery only promotes a staging record that has a
      // matching commit marker.
    }
  }
}

async function persistJournalPrimary(
  key: string,
  body: string,
): Promise<Extract<JournalWriteResult, { ok: false }> | null> {
  try {
    await journalSeams.setDurable(key, body);
    return null;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "storage refused the write";
    if (/quota|full|storage refused/i.test(message)) {
      return { ok: false, code: "quota_failure", message };
    }
    return { ok: false, code: "interrupted_write", message };
  }
}

export function readJournalPayload<T>(key: string): T | null {
  return recoverJournal<T>(key)?.payload ?? null;
}

export function clearJournal(key: string): void {
  kvDelete(key);
  kvDelete(stagingKey(key));
  kvDelete(commitKey(key));
}

/**
 * Remove a journal and wait for storage to forget it, so a caller can say it
 * is gone rather than that it was asked to go. Every record is attempted
 * even if one refuses; the first refusal is then reported.
 */
export async function clearJournalDurable(key: string): Promise<void> {
  let refusal: unknown;
  for (const record of [key, stagingKey(key), commitKey(key)]) {
    try {
      await journalSeams.deleteDurable(record);
    } catch (error) {
      refusal ??= error;
    }
  }
  if (refusal !== undefined) throw refusal;
}
