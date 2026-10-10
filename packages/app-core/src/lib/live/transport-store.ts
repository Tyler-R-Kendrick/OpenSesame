/**
 * The owner's live-session transport profile, sealed in the tomb
 * (ADR 0150 §6; ADR 0134). It can hold TURN credentials, a TURN REST secret
 * and carrier passwords, so it is never written in the clear; and it names
 * this person's tailnet addresses, which are nobody else's business either.
 *
 * Absent — the default — a session is direct only and contacts nothing.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { kvRefresh } from "../kv.js";
import { VfsError, readFile, tombFileKey, writeFile } from "../vfs.js";
import {
  type LiveTransport,
  type TransportRead,
  readTransport,
  transportFileText,
} from "./transport.js";

export const TRANSPORT_PATH = "config/live-transport";
const MAX_BYTES = 32_000;

/** The sealed file underneath; tests stand a memory in its place. */
export const storeSeams = {
  refresh: (tomb: string): Promise<void> =>
    kvRefresh(tombFileKey(tomb, TRANSPORT_PATH), MAX_BYTES * 2),
  read: (tomb: string): Promise<Uint8Array> => readFile(tomb, TRANSPORT_PATH),
  write: (tomb: string, bytes: Uint8Array): Promise<void> =>
    writeFile(tomb, TRANSPORT_PATH, bytes),
};

const listeners = new Set<() => void>();

/** Hear every write of the profile, from the Form or the file viewer. */
export function onTransportChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The saved profile cannot be used: it is there and does not read, or the
 * vault cannot be opened. A session never starts on a guess at it — falling
 * back to "direct only" would drop a `relay: true` and show the owner's
 * address to whoever is admitted.
 */
export class TransportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportRefused";
  }
}

/**
 * The file text as sealed, whatever it says (the file viewer must show a
 * broken file to be fixed), or `{}` where nothing was ever written.
 */
export async function readTransportText(tomb: string): Promise<string> {
  await storeSeams.refresh(tomb);
  try {
    return new TextDecoder().decode(await storeSeams.read(tomb));
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return "{}\n";
    throw error;
  }
}

/** Parse the file's text; JSON errors read as a refusal. */
export function parseTransportText(text: string): TransportRead {
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    return { ok: false, errors: ["The profile is too large."] };
  let value: BoundaryValue;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["The profile is not valid JSON."] };
  }
  return readTransport(value);
}

/**
 * The profile in effect: what was sealed, or direct only where nothing was
 * ever written. Throws `TransportRefused` for one that is there and is not
 * usable, or a vault that cannot be read.
 */
export async function readLiveTransport(tomb: string): Promise<LiveTransport> {
  let text: string;
  try {
    text = await readTransportText(tomb);
  } catch (error) {
    if (error instanceof VfsError && error.code === "locked")
      throw new TransportRefused("Unlock this vault to read its routes");
    throw new TransportRefused("This vault's routes could not be read");
  }
  const read = parseTransportText(text);
  if (!read.ok) throw new TransportRefused(read.errors[0] ?? "Refused.");
  return read.transport;
}

/** Writes and edits to one tomb settle in the order they were asked for. */
const chains = new Map<string, Promise<void>>();

function inTurn<T>(tomb: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(tomb) ?? Promise.resolve()).then(task);
  chains.set(
    tomb,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function seal(tomb: string, transport: LiveTransport): Promise<void> {
  const text = transportFileText(transport);
  const checked = parseTransportText(text);
  if (!checked.ok) throw new Error(checked.errors[0] ?? "Refused.");
  await storeSeams.write(tomb, new TextEncoder().encode(text));
  for (const listener of listeners) listener();
}

/**
 * Seal a profile, written in its canonical form. Two writes never overlap:
 * a slow first cannot land after a fast second and put the older profile
 * back.
 */
export function writeLiveTransport(
  tomb: string,
  transport: LiveTransport,
): Promise<void> {
  return inTurn(tomb, () => seal(tomb, transport));
}

/**
 * Apply `edit` to the profile as sealed when its turn comes, and seal what it
 * gives: the read and the write are one turn, so a write from elsewhere (the
 * file viewer) lands before the read or after the write, never between them
 * to be put back by an edit computed from what was there before it. A refused
 * edit writes nothing; a profile that cannot be read throws
 * `TransportRefused`, as `readLiveTransport` does.
 */
export function editLiveTransport(
  tomb: string,
  edit: (current: LiveTransport) => TransportRead,
): Promise<TransportRead> {
  return inTurn(tomb, async () => {
    const next = edit(await readLiveTransport(tomb));
    if (next.ok) await seal(tomb, next.transport);
    return next;
  });
}
