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

import {
  CONNECTIONS_MAX,
  CONNECTION_ID,
  type DeviceConnection,
  type DeviceItem,
  OPERATIONS_MAX,
  PROVIDER_ID,
  isOperationId,
} from "./connection-wire.js";

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

/**
 * A call the port refuses because of what the device asked, not because a
 * provider failed: the device is told its request was not one.
 */
export class InvalidCall extends Error {
  constructor() {
    super("invalid_call");
    this.name = "InvalidCall";
  }
}

export interface ConnectionPort {
  /** The connections a device could be granted, as they stand now. */
  list(): readonly SessionConnection[];
  /** One value-blind operation on one connection. Rejects on any failure; `InvalidCall` when the ask itself was wrong. */
  invoke(call: SessionCall): Promise<SessionResult>;
}

let bound: ConnectionPort | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Bind the port for the life of one activation; returns how to release it. A
 * port it replaces is simply replaced, and its release then leaves the new
 * one alone — the same shape as the model-key broker's binding.
 */
export function bindConnectionPort(port: ConnectionPort): () => void {
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

const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu;
const LABEL_MAX = 120;

/**
 * A connection as the wire may carry it, or null if it cannot be named there.
 * A label the owner typed can hold anything, and a device's reader refuses a
 * message it cannot read whole — so what is sent is cleaned first, and an id
 * the grammar cannot spell is a connection a device is not offered.
 */
export function wireConnection(
  held: SessionConnection,
): DeviceConnection | null {
  if (!CONNECTION_ID.test(held.id)) return null;
  const label = [
    ...held.label.replace(UNSAFE, " ").replace(/\s+/gu, " ").trim(),
  ]
    .slice(0, LABEL_MAX)
    .join("");
  return {
    id: held.id,
    label: label === "" ? held.id : label,
    provider: PROVIDER_ID.test(held.provider) ? held.provider : "other",
    operations: held.operations
      .filter((entry) => isOperationId(entry) && !revealsSecret(entry))
      .slice(0, OPERATIONS_MAX),
  };
}

/**
 * What a port offers a device, as the wire may carry it: no more connections
 * than one frame may name, so that whatever the owner is shown, allows and
 * is then told about is something the device can read.
 */
export function offeredBy(
  port: ConnectionPort | null,
): readonly DeviceConnection[] {
  return (port?.list() ?? [])
    .flatMap((held) => {
      const wire = wireConnection(held);
      return wire ? [wire] : [];
    })
    .slice(0, CONNECTIONS_MAX);
}
