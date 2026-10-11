/**
 * The file a person chose at the door to start a vault from (ADR 0188).
 *
 * A device with no vault has nowhere to put what a file holds, and the import
 * pipeline is the `vault.interop-formats` capability's: the door cannot load
 * it, because nothing optional is imported before an approved plan says so
 * (ADR 0130). So the door only holds the `File` — in memory, unread, never
 * written anywhere — while the person seals the vault, and the capability's
 * Import key takes it once the vault is open and reads it with the pipeline
 * every other import uses.
 *
 * A `File` does not survive a reload, and nothing here tries to make it.
 */

/**
 * What the file picker offers, for the door and for the Import key alike: the
 * formats the pipeline reads. A dotenv file is the first of them.
 */
export const IMPORT_ACCEPT =
  ".env,.csv,.json,.1pux,.zip,.kdbx,text/plain,text/csv,application/json";

type Listener = () => void;

let held: File | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Hold `file` for the vault that is about to be sealed. Replaces any held. */
export function holdPendingImport(file: File): void {
  held = file;
  emit();
}

/** The held file, left in place: what the seal screen names. */
export function peekPendingImport(): File | null {
  return held;
}

/** Let go of the held file: the person changed their mind. */
export function discardPendingImport(): void {
  if (held === null) return;
  held = null;
  emit();
}

/** The held file, handed over once: whoever takes it is the one to read it. */
export function takePendingImport(): File | null {
  const taken = held;
  if (taken !== null) discardPendingImport();
  return taken;
}

/** For a React binding: called when a file is held or let go. */
export function subscribePendingImport(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
