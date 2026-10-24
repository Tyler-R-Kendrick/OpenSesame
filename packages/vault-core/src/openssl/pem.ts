/**
 * OpenSSL-compatible PEM armour: one or more labelled, base64-armoured DER
 * blocks with optional legacy headers (`Proc-Type`, `DEK-Info`). The parser
 * is deliberately bounded; callers decide which labels they accept.
 *
 * It does not decrypt anything. An encrypted PKCS#8 or legacy encrypted key
 * is recognised and returned as armour, with its encryption state left for
 * the caller to report.
 */
import { isString } from "@opensesame/os-domain";
import { b64ToBytes, bytesToB64 } from "../bytes.js";

export type PemBlock = {
  readonly label: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly der: Uint8Array;
};

export class PemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PemError";
  }
}

/** One PEM file, not a vault: bounded before any base64 is decoded. */
export const PEM_MAX_TEXT_BYTES = 1_048_576;
export const PEM_MAX_DER_BYTES = 262_144;
export const PEM_MAX_BLOCKS = 64;
const BEGIN = /^-----BEGIN ([A-Z0-9][A-Z0-9 ]{0,63})-----$/u;
const HEADER = /^([A-Za-z0-9-]+):[ \t]*(.*)$/u;

/** Decode one or more PEM blocks in order. Surrounding prose is ignored. */
export function parsePemBlocks(text: string): PemBlock[] {
  if (!isString(text)) throw new PemError("PEM input is not text");
  if (text.length > PEM_MAX_TEXT_BYTES)
    throw new PemError("PEM input is too large");
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const blocks: PemBlock[] = [];
  let at = 0;
  while (at < lines.length) {
    const found = blockAt(lines, at);
    if (found === null) {
      at += 1;
      continue;
    }
    blocks.push(found.block);
    if (blocks.length > PEM_MAX_BLOCKS)
      throw new PemError("too many PEM blocks");
    at = found.next;
  }
  return blocks;
}

type BlockRead = { readonly block: PemBlock; readonly next: number };

function blockAt(lines: readonly string[], start: number): BlockRead | null {
  const begin = BEGIN.exec(lines[start] ?? "");
  if (!begin) return null;
  const label = begin[1] ?? "";
  const endMarker = `-----END ${label}-----`;
  const body: string[] = [];
  const headers = new Map<string, string>();
  let inBody = false;
  let at = start + 1;
  for (; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (line === endMarker) return finishBlock(label, headers, body, at + 1);
    if (line.startsWith("-----BEGIN ")) throw new PemError("nested PEM block");
    if (!inBody && line.trim() === "") {
      inBody = true;
      continue;
    }
    if (!inBody) {
      const header = HEADER.exec(line);
      if (header) {
        headers.set(header[1] ?? "", (header[2] ?? "").trim());
        continue;
      }
    }
    inBody = true;
    body.push(line.trim());
  }
  throw new PemError("PEM block has no end marker");
}

function finishBlock(
  label: string,
  headers: ReadonlyMap<string, string>,
  body: readonly string[],
  next: number,
): BlockRead {
  const encoded = body.join("");
  if (encoded === "") throw new PemError("PEM block has no body");
  let der: Uint8Array;
  try {
    der = b64ToBytes(encoded);
  } catch {
    throw new PemError("PEM body is not base64");
  }
  if (der.length === 0 || der.length > PEM_MAX_DER_BYTES)
    throw new PemError("PEM body is outside its size limit");
  return {
    block: { label, headers: Object.freeze(Object.fromEntries(headers)), der },
    next,
  };
}

/** PEM armour in 64-character lines, with a trailing newline. */
export function toPem(der: Uint8Array, label: string): string {
  const encoded = bytesToB64(der);
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += 64)
    lines.push(encoded.slice(at, at + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A certificate label OpenSSL and Bouncy Castle both write. */
export function isCertificateLabel(label: string): boolean {
  return (
    label === "CERTIFICATE" ||
    label === "X509 CERTIFICATE" ||
    label === "TRUSTED CERTIFICATE"
  );
}

/** A PKCS#10 request label, including OpenSSL's older `NEW` spelling. */
export function isCertificateRequestLabel(label: string): boolean {
  return label === "CERTIFICATE REQUEST" || label === "NEW CERTIFICATE REQUEST";
}

/** A PKCS#7/CMS container label used by OpenSSL and Bouncy Castle. */
export function isCmsLabel(label: string): boolean {
  return label === "PKCS7" || label === "CMS";
}
