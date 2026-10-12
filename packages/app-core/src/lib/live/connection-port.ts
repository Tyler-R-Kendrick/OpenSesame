/**
 * The connections this tab can use on a device's behalf (ADR 0195).
 *
 * A live session's owner may let a *device* (a terminal, an agent) use some of
 * the connections configured in this app. The session does not know how any
 * of them is made or what holds its credential; it knows this port, which the
 * capability that owns the connections binds while it is active
 * (`connectors.external`, in Pages). That keeps the sharing capability from
 * reaching the connections' code, and means a tab with no connections — or
 * with the connections capability off — simply offers nothing.
 *
 * What crosses the port is value-blind by construction. `list` names a
 * connection, its provider and the operations a device may ask of it; `invoke`
 * takes an operation and a few bounded strings and answers with labelled
 * lines. A credential is on neither side, and an operation that would reveal
 * one is never listed.
 */

import type { DeviceConnection, DeviceItem } from "./device-messages.js";

export type SessionConnection = DeviceConnection;

export type SessionCall = Readonly<{
  connection: string;
  operation: string;
  input: Readonly<Record<string, string>>;
  /** Aborted when the grant ends, the session ends or the call times out. */
  signal: AbortSignal;
}>;

export type SessionResult = Readonly<{
  label: string;
  items: readonly DeviceItem[];
}>;

export interface ConnectionPort {
  /** The connections a device could be granted, as they stand now. */
  list(): readonly SessionConnection[];
  /** One value-blind operation on one connection. Rejects on any failure. */
  invoke(call: SessionCall): Promise<SessionResult>;
}

let bound: ConnectionPort | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/** Bind the port for the life of one activation; returns how to release it. */
export function bindConnectionPort(port: ConnectionPort): () => void {
  if (bound) throw new Error("The session connection port is already bound");
  bound = port;
  changed();
  return () => {
    if (bound !== port) return;
    bound = null;
    changed();
  };
}

/** The bound port, or null while the capability that owns it is not active. */
export function connectionPort(): ConnectionPort | null {
  return bound;
}

/** Hear the port being bound or released. */
export function onConnectionPort(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * An operation a device may never name, whatever a port lists: anything whose
 * id says it reads a secret. The port decides what it offers; this is the
 * session refusing, on its own, the one kind of operation that has no place
 * here.
 */
export function revealsSecret(operation: string): boolean {
  return /secret|credential|password|token|api_?key/i.test(operation);
}
