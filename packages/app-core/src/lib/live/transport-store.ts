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
  DIRECT_TRANSPORT,
  type LiveTransport,
  type TransportRead,
  readTransport,
  transportFileText,
} from "./transport.js";

export const TRANSPORT_PATH = "config/live-transport";
const MAX_BYTES = 32_000;

const listeners = new Set<() => void>();

/** Hear every write of the profile, from the Form or the file viewer. */
export function onTransportChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The file text as sealed, or `{}` where nothing was ever written. */
export async function readTransportText(tomb: string): Promise<string> {
  await kvRefresh(tombFileKey(tomb, TRANSPORT_PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, TRANSPORT_PATH);
    if (bytes.length > MAX_BYTES) return "{}\n";
    return new TextDecoder().decode(bytes);
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

/** The profile in effect: what was sealed, or direct only. */
export async function readLiveTransport(tomb: string): Promise<LiveTransport> {
  const read = parseTransportText(await readTransportText(tomb));
  return read.ok ? read.transport : DIRECT_TRANSPORT;
}

/** Seal a profile, written in its canonical form. */
export async function writeLiveTransport(
  tomb: string,
  transport: LiveTransport,
): Promise<void> {
  const text = transportFileText(transport);
  const checked = parseTransportText(text);
  if (!checked.ok) throw new Error(checked.errors[0] ?? "Refused.");
  await writeFile(tomb, TRANSPORT_PATH, new TextEncoder().encode(text));
  for (const listener of listeners) listener();
}
