/**
 * The pairing code a machine on the tailnet prints when it opens a drive slot
 * (`opensesame vault-drive create`, ADR 0140) — Enpass's Wi-Fi Sync QR, as text.
 *
 * It carries where the drive is, which slot, and the slot's access key. The
 * key lets its holder read and replace one ciphertext snapshot; it opens
 * nothing. The address must be one a tailnet serves (a `*.ts.net` name, a
 * `100.64.0.0/10` address, a bare MagicDNS name) or loopback, so a pasted code
 * cannot point this page at an arbitrary public server.
 */
import { isJsonObject, isString } from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";
import { normalizeTailnetBase } from "../urls.js";

export const PAIRING_PREFIX = "opensesame-drive:v1:";

export type DrivePairing = {
  /** Base URL of the daemon serving the drive. */
  url: string;
  slot: string;
  /** The slot's access key. Sealed in the vault once it is open. */
  key: string;
  /** What the operator called the slot, shown to the person pairing. */
  label: string;
};

const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

/** A tailnet name or address, or this machine — never the open internet. */
export function isTailnetOrLoopback(base: string): boolean {
  const host = new URL(base).hostname.toLowerCase();
  return (
    host.endsWith(".ts.net") ||
    CGNAT.test(host) ||
    !host.includes(".") ||
    host === "127.0.0.1" ||
    host === "[::1]"
  );
}

const SLOT = /^[a-z0-9][a-z0-9-]{7,63}$/;
const KEY = /^[A-Za-z0-9_-]{32,128}$/;

function decodeJson(text: string) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(text)));
  } catch {
    return null;
  }
}

/** Parse a pasted pairing code, or null when it is not one this page will use. */
export function parsePairingCode(raw: string): DrivePairing | null {
  const text = raw.trim();
  if (!text.startsWith(PAIRING_PREFIX)) return null;
  const decoded = decodeJson(text.slice(PAIRING_PREFIX.length));
  if (!isJsonObject(decoded)) return null;
  const { url, slot, key, label } = decoded;
  if (!isString(url) || !isString(slot) || !isString(key)) return null;
  const base = normalizeTailnetBase(url);
  if (!base || !isTailnetOrLoopback(base) || !SLOT.test(slot) || !KEY.test(key))
    return null;
  return {
    url: base,
    slot,
    key,
    label: isString(label) ? label.slice(0, 80) : "",
  };
}

/** The inverse, for tests and for the CLI's format contract. */
export function formatPairingCode(pairing: DrivePairing): string {
  const json = JSON.stringify({
    url: pairing.url,
    slot: pairing.slot,
    key: pairing.key,
    label: pairing.label,
  });
  return `${PAIRING_PREFIX}${bytesToB64url(new TextEncoder().encode(json))}`;
}
