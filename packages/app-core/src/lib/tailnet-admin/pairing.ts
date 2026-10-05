/**
 * The pairing code `opensesame daemon tailnet pair` prints (ADR 0165 §3,
 * `spec/conformance/tailnet-admin-protocol.json`), and where the bearer it
 * is traded for is kept.
 *
 * The code carries where the daemon is, a one-time secret, the one origin
 * that may trade it, the role the bearer will hold and a label. The page
 * trades the secret, once, for a bearer that opens the daemon's tailnet
 * routes from this origin only. The address must be a tailnet name or this
 * machine, so a pasted code cannot point this page at a public server.
 *
 * The bearer is sealed in the open vault's tomb at `config/tailnet-admin`:
 * readable only while the vault is open, dropped with the tomb, never in the
 * clear. A guest has nowhere to seal it and cannot pair.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";
import { SECRET, isPairableOrigin } from "../tailnet-sync/plugin-pairing.js";
import { isTailnetOrLoopback, normalizeTailnetBase } from "../urls.js";
import { VfsError, deleteFile, readFile, writeFile } from "../vfs.js";

export const TAILNET_PAIRING_PREFIX = "opensesame-tailnet:v1:";
export const TAILNET_PAIRING_PATH = "/v1/tailnet/pairing";
export const TAILNET_ADMIN_CONFIG_PATH = "config/tailnet-admin";
/** The fragment key a pairing link carries (`#pair-tailnet=<code>`). */
export const TAILNET_LINK_KEY = "pair-tailnet=";

/** What a bearer may do: `read`, or every change too. */
export type TailnetRole = "read" | "manage";

export function isTailnetRole(value: BoundaryValue): value is TailnetRole {
  return value === "read" || value === "manage";
}

/** What a printed code says; `code` is spent the first time it is traded. */
export type TailnetPairingCode = Readonly<{
  url: string;
  code: string;
  origin: string;
  role: TailnetRole;
  label: string;
}>;

/** What this page keeps once the code is traded: sealed, never shown. */
export type TailnetAdminPairing = Readonly<{
  url: string;
  /** The bearer the daemon issued, for `origin` and `role` alone. */
  token: string;
  origin: string;
  role: TailnetRole;
  label: string;
}>;

function daemonBase(url: string): string | null {
  const base = normalizeTailnetBase(url);
  return base && isTailnetOrLoopback(base) ? base : null;
}

function label(value: BoundaryValue): string {
  return isString(value) ? value.slice(0, 80) : "";
}

function decodeJson(text: string): BoundaryValue {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(text)));
  } catch {
    return null;
  }
}

/** Parse a pasted code, or null when it is not one this page will use. */
export function parseTailnetPairingCode(
  raw: string,
): TailnetPairingCode | null {
  const text = raw.trim();
  if (!text.startsWith(TAILNET_PAIRING_PREFIX)) return null;
  const decoded = decodeJson(text.slice(TAILNET_PAIRING_PREFIX.length));
  if (!isJsonObject(decoded)) return null;
  const { url, code, origin, role } = decoded;
  if (!isString(url) || !isString(code) || !isString(origin)) return null;
  const base = daemonBase(url);
  if (!base || !SECRET.test(code) || !isPairableOrigin(origin)) return null;
  if (!isTailnetRole(role)) return null;
  return { url: base, code, origin, role, label: label(decoded.label) };
}

/** The inverse, for tests: the same bytes the CLI prints. */
export function formatTailnetPairingCode(pairing: TailnetPairingCode): string {
  const json = JSON.stringify({
    code: pairing.code,
    label: pairing.label,
    origin: pairing.origin,
    role: pairing.role,
    url: pairing.url,
  });
  return `${TAILNET_PAIRING_PREFIX}${bytesToB64url(new TextEncoder().encode(json))}`;
}

/** A stored pairing that still passes every check a fresh one would. */
export function parseTailnetAdminPairing(
  raw: BoundaryValue,
): TailnetAdminPairing | null {
  if (!isJsonObject(raw)) return null;
  const { url, token, origin, role } = raw;
  if (!isString(url) || !isString(token) || !isString(origin)) return null;
  const base = daemonBase(url);
  if (!base || !SECRET.test(token) || !isPairableOrigin(origin)) return null;
  if (!isTailnetRole(role)) return null;
  return { url: base, token, origin, role, label: label(raw.label) };
}

export async function readTailnetAdminConfig(
  tomb: string,
): Promise<TailnetAdminPairing | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(tomb, TAILNET_ADMIN_CONFIG_PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
  try {
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return isJsonObject(parsed) && parsed.v === 1
      ? parseTailnetAdminPairing(parsed.pairing)
      : null;
  } catch {
    return null;
  }
}

export async function writeTailnetAdminConfig(
  tomb: string,
  pairing: TailnetAdminPairing | null,
): Promise<void> {
  if (!pairing) {
    await deleteFile(tomb, TAILNET_ADMIN_CONFIG_PATH);
    return;
  }
  const text = JSON.stringify({ v: 1, pairing });
  await writeFile(
    tomb,
    TAILNET_ADMIN_CONFIG_PATH,
    new TextEncoder().encode(text),
  );
}
