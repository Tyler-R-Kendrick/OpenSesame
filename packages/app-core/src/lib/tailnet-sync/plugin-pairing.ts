/**
 * The pairing code `opensesame plugins pair --origin <origin>` prints
 * (ADR 0150 §7, `spec/conformance/plugin-pairing.json`), and where the key it
 * is traded for is kept.
 *
 * The code carries where the daemon is, a one-time secret, the one origin
 * the daemon will accept it from, and a label. The page trades the secret,
 * once, for a key that opens the daemon's plugin routes and nothing else,
 * and only from that origin. The address must be a tailnet name or this
 * machine, as for a drive, so a pasted code cannot point this page at a
 * public server.
 *
 * The key is sealed in the open vault's own tomb, like the drive's slot key:
 * readable only while the vault is open, dropped with the tomb, never in the
 * clear. A guest has no key to seal it under and cannot pair.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";
import { isTailnetOrLoopback, normalizeTailnetBase } from "../urls.js";
import { VfsError, deleteFile, readFile, writeFile } from "../vfs.js";

export const PLUGIN_PAIRING_PREFIX = "opensesame-plugins:v1:";
export const PLUGIN_PAIRING_EXCHANGE_PATH = "/v1/plugins/pairing";
export const PLUGIN_DAEMON_CONFIG_PATH = "config/plugin-daemon";

/** What a printed code says; `code` is spent the first time it is traded. */
export type PluginPairingCode = Readonly<{
  url: string;
  code: string;
  origin: string;
  label: string;
}>;

/** What this page keeps once the code is traded: sealed, never shown. */
export type PluginDaemonPairing = Readonly<{
  url: string;
  /** The bearer the daemon issued; opens `/v1/plugins` from `origin` only. */
  token: string;
  origin: string;
  label: string;
}>;

/** 32 random bytes, unpadded base64url: the code and the key alike. */
export const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Exactly what a browser sends: `https://host[:port]` or `http://localhost:port`. */
export function isPairableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password) return false;
  if (url.protocol === "https:") return !url.hostname.endsWith(".");
  return (
    url.protocol === "http:" && url.hostname === "localhost" && url.port !== ""
  );
}

function daemonBase(url: string): string | null {
  const base = normalizeTailnetBase(url);
  return base && isTailnetOrLoopback(base) ? base : null;
}

function decodeJson(text: string) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(text)));
  } catch {
    return null;
  }
}

/** Parse a pasted code, or null when it is not one this page will use. */
export function parsePluginPairingCode(raw: string): PluginPairingCode | null {
  const text = raw.trim();
  if (!text.startsWith(PLUGIN_PAIRING_PREFIX)) return null;
  const decoded = decodeJson(text.slice(PLUGIN_PAIRING_PREFIX.length));
  if (!isJsonObject(decoded)) return null;
  const { url, code, origin, label } = decoded;
  if (!isString(url) || !isString(code) || !isString(origin)) return null;
  const base = daemonBase(url);
  if (!base || !SECRET.test(code) || !isPairableOrigin(origin)) return null;
  return {
    url: base,
    code,
    origin,
    label: isString(label) ? label.slice(0, 80) : "",
  };
}

/** The inverse, for tests: the same bytes the CLI prints. */
export function formatPluginPairingCode(pairing: PluginPairingCode): string {
  const json = JSON.stringify({
    code: pairing.code,
    label: pairing.label,
    origin: pairing.origin,
    url: pairing.url,
  });
  return `${PLUGIN_PAIRING_PREFIX}${bytesToB64url(new TextEncoder().encode(json))}`;
}

/** A stored pairing that still passes every check a fresh one would. */
export function parsePluginDaemonPairing(
  raw: BoundaryValue | undefined,
): PluginDaemonPairing | null {
  if (!isJsonObject(raw)) return null;
  const { url, token, origin, label } = raw;
  if (!isString(url) || !isString(token) || !isString(origin)) return null;
  const base = daemonBase(url);
  if (!base || !SECRET.test(token) || !isPairableOrigin(origin)) return null;
  return {
    url: base,
    token,
    origin,
    label: isString(label) ? label.slice(0, 80) : "",
  };
}

export async function readPluginDaemonConfig(
  tomb: string,
): Promise<PluginDaemonPairing | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(tomb, PLUGIN_DAEMON_CONFIG_PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return isJsonObject(parsed) && parsed.v === 1
      ? parsePluginDaemonPairing(parsed.pairing)
      : null;
  } catch {
    return null;
  }
}

export async function writePluginDaemonConfig(
  tomb: string,
  pairing: PluginDaemonPairing | null,
): Promise<void> {
  if (!pairing) {
    await deleteFile(tomb, PLUGIN_DAEMON_CONFIG_PATH);
    return;
  }
  const text = JSON.stringify({ v: 1, pairing });
  await writeFile(
    tomb,
    PLUGIN_DAEMON_CONFIG_PATH,
    new TextEncoder().encode(text),
  );
}
