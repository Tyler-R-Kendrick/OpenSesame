/**
 * The three daemon calls Settings makes about a plugin (ADR 0150 §7), over a
 * port the capability hands in — so this file names no transport, holds no
 * key and imports no optional code. The port the plugin capabilities use is
 * the daemon a person paired this page with (`opensesame plugins pair`,
 * `lib/tailnet-sync/plugin-daemon.ts`).
 *
 * Installing is not here and never will be: a plugin is installed by a
 * person at a terminal (`opensesame plugins install …`), never over HTTP.
 * Switching one is refused before anything is sent when the last read says
 * it is not installed, or says the daemon's environment forces it off —
 * nothing on this page can turn on what the operator turned off.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { readBoundedObject } from "../bounded-response.js";
import { type PluginId, pluginById } from "./catalog.js";
import {
  type PluginNotice,
  type PluginState,
  errorCodeOf,
  parseNoticeList,
  parsePluginList,
  parsePluginState,
} from "./wire.js";

export type PluginErrorCode =
  /** No daemon is paired with the open vault. */
  | "no-daemon"
  /** The request never got an answer (offline, refused by the browser, timed out). */
  | "unreachable"
  /** The daemon would not let this device in. */
  | "unauthorized"
  /** The daemon answered, but not with what these routes promise. */
  | "malformed"
  | "not-installed"
  | "forced-off"
  | "unknown-plugin"
  /** Switching on refused: the binary changed since it was installed. */
  | "pin-mismatch"
  /** What was pasted is not a plugin pairing code this page will use. */
  | "not-a-code"
  /** The code was printed for another origin than this page's. */
  | "other-origin"
  /** The daemon would not trade the code: used, expired, or asked too often. */
  | "pairing-refused"
  /** No open vault to seal a pairing in (locked, or a guest). */
  | "locked"
  /** Any other refusal. */
  | "refused";

export class PluginError extends Error {
  constructor(readonly code: PluginErrorCode) {
    super(`plugin request failed: ${code}`);
    this.name = "PluginError";
  }
}

/** Where the daemon is, for a label: never its key, never a full URL. */
export type PluginDaemonTarget = Readonly<{ label: string; host: string }>;

export type PluginDaemonRequest = Readonly<{
  method: "GET" | "PUT";
  body?: string;
  signal: AbortSignal;
}>;

/** The daemon a capability talks to; it adds whatever proves the caller. */
export type PluginDaemon = Readonly<{
  target(): PluginDaemonTarget | null;
  request(path: string, init: PluginDaemonRequest): Promise<Response>;
  /** Told when `target` may have changed (paired, forgotten, vault switched). */
  subscribe?(listener: () => void): () => void;
  /** Whether a pairing could be kept now; absent where the port cannot pair. */
  canPair?(): boolean;
  /** Trade a pasted pairing code for this page's own key. */
  pair?(code: string, signal: AbortSignal): Promise<void>;
  /** Forget this page's key, and revoke it at the daemon when it answers. */
  forget?(signal: AbortSignal): Promise<void>;
}>;

const MAX_BYTES = 64 * 1024;
const BODY_MS = 8000;

async function send(
  daemon: PluginDaemon,
  path: string,
  init: PluginDaemonRequest,
): Promise<Response> {
  if (daemon.target() === null) throw new PluginError("no-daemon");
  try {
    return await daemon.request(path, init);
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError("unreachable");
  }
}

async function body(response: Response): Promise<BoundaryValue> {
  try {
    return await readBoundedObject(response, MAX_BYTES, BODY_MS);
  } catch {
    throw new PluginError("malformed");
  }
}

async function refusal(response: Response): Promise<PluginError> {
  if (response.status === 401 || response.status === 403)
    return new PluginError("unauthorized");
  const code = await body(response).then(errorCodeOf, () => null);
  if (response.status === 404 && code === "not_installed")
    return new PluginError("not-installed");
  if (response.status === 400 && code === "unknown_plugin")
    return new PluginError("unknown-plugin");
  if (response.status === 409 && code === "pin_mismatch")
    return new PluginError("pin-mismatch");
  return new PluginError("refused");
}

/** Every plugin this page knows, as the daemon reports it. */
export async function readPluginStates(
  daemon: PluginDaemon,
  signal: AbortSignal,
): Promise<PluginState[]> {
  const response = await send(daemon, "/v1/plugins", { method: "GET", signal });
  if (!response.ok) throw await refusal(response);
  const list = parsePluginList(await body(response));
  if (list === null) throw new PluginError("malformed");
  return list;
}

/**
 * Switch one plugin, given what the last read said about it. The answer
 * must be about the same plugin; anything else is refused, not drawn.
 */
export async function setPluginEnabled(
  daemon: PluginDaemon,
  current: PluginState,
  enabled: boolean,
  signal: AbortSignal,
): Promise<PluginState> {
  if (!current.installed) throw new PluginError("not-installed");
  if (enabled && current.forcedOff) throw new PluginError("forced-off");
  const response = await send(daemon, `/v1/plugins/${current.id}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
    signal,
  });
  if (!response.ok) throw await refusal(response);
  const next = parsePluginState(await body(response));
  if (next === null || next.id !== current.id)
    throw new PluginError("malformed");
  return next;
}

/** The plugin's recent tripwires, newest first; only for one that keeps them. */
export async function readPluginNotices(
  daemon: PluginDaemon,
  id: PluginId,
  signal: AbortSignal,
): Promise<PluginNotice[]> {
  if (!pluginById(id).notices) return [];
  const response = await send(daemon, `/v1/plugins/${id}/notices`, {
    method: "GET",
    signal,
  });
  if (!response.ok) throw await refusal(response);
  const list = parseNoticeList(await body(response));
  if (list === null) throw new PluginError("malformed");
  return list;
}
