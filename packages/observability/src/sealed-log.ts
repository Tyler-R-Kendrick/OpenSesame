/**
 * An encrypted, rotating log file for the TypeScript services (ADR 0155).
 *
 * The same format as `crates/sealed-log`, so one reader opens both: each line is
 * `osl1.` + base64url(24-byte nonce | XChaCha20-Poly1305 ciphertext and tag),
 * sealed on its own under a 32-byte key that lives apart from the file (its own
 * 0600 key file, or a path an operator points at a secret mount). The vectors in
 * `spec/conformance/sealed-log-vectors.json` are opened by both implementations.
 *
 * A sealed log that cannot be opened or keyed throws: the service refuses to
 * start rather than log into the clear.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { scrubText } from "@opensesame/log-scrub";

export const SEALED_LINE_PREFIX = "osl1.";
/** What stands in for a sealed line that does not open. */
export const UNREADABLE = "[sealed line: not readable with this key]";
const AAD = new TextEncoder().encode("opensesame.log.v1");
const NONCE_BYTES = 24;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP = 3;

export type LogKey = Uint8Array;

function fromHex(text: string): Uint8Array | undefined {
  const clean = text.trim();
  if (!/^[0-9a-f]{64}$/i.test(clean)) return undefined;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

/** Read the key at `path` without creating one. */
export function loadLogKey(path: string): LogKey {
  const key = fromHex(readFileSync(path, "utf8"));
  if (!key) throw new Error(`${path} does not hold a 32-byte hex log key`);
  return key;
}

/**
 * Read the key at `path`, or create it there (mode 0600, never overwriting).
 * A key file that exists but holds no key is an error: minting a new one over it
 * would orphan every line already sealed. The key is written whole to a private
 * sibling and linked into place, so a reader never sees a half-written key.
 */
export function loadOrCreateLogKey(path: string): LogKey {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return loadLogKey(path);
  const key = Uint8Array.from(randomBytes(32));
  const staging = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(staging, "wx", 0o600);
  try {
    writeSync(fd, `${Buffer.from(key).toString("hex")}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(staging, path);
    return key;
  } catch (error) {
    // Another process published its key first: use that one.
    if (existsSync(path)) return loadLogKey(path);
    throw error;
  } finally {
    rmSync(staging, { force: true });
  }
}

/** Seal one line (without its newline). */
export function sealLogLine(key: LogKey, line: string): string {
  const nonce = Uint8Array.from(randomBytes(NONCE_BYTES));
  const body = xchacha20poly1305(key, nonce, AAD).encrypt(
    new TextEncoder().encode(line),
  );
  const packed = new Uint8Array(nonce.length + body.length);
  packed.set(nonce);
  packed.set(body, nonce.length);
  return `${SEALED_LINE_PREFIX}${Buffer.from(packed).toString("base64url")}`;
}

/** Open one sealed line, or `null` when it is not one, is torn or was sealed under another key. */
export function openLogLine(key: LogKey, sealed: string): string | null {
  const text = sealed.trim();
  if (!text.startsWith(SEALED_LINE_PREFIX)) return null;
  const packed = Uint8Array.from(
    Buffer.from(text.slice(SEALED_LINE_PREFIX.length), "base64url"),
  );
  if (packed.length <= NONCE_BYTES) return null;
  try {
    const plain = xchacha20poly1305(
      key,
      packed.subarray(0, NONCE_BYTES),
      AAD,
    ).decrypt(packed.subarray(NONCE_BYTES));
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

function rotatedPath(path: string, generation: number): string {
  return `${path}.${generation}`;
}

export interface SealedLogOptions {
  maxBytes?: number;
  keep?: number;
}

/** What pino writes lines to. */
export interface LogDestination {
  write(message: string): void;
}

/** The file lines are sealed into: owner-only, rotating whole files. */
export class SealedLogFile {
  readonly #path: string;
  readonly #key: LogKey;
  readonly #maxBytes: number;
  readonly #keep: number;
  #length: number;

  constructor(path: string, key: LogKey, options: SealedLogOptions = {}) {
    this.#path = path;
    this.#key = key;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#keep = options.keep ?? DEFAULT_KEEP;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "", { mode: 0o600 });
    // `mode` applies only when the file is created; one an older build left
    // wider is narrowed here.
    chmodSync(path, 0o600);
    this.#length = statSync(path).size;
  }

  #rotate(): void {
    if (this.#keep === 0) {
      rmSync(this.#path, { force: true });
    } else {
      for (let generation = this.#keep - 1; generation >= 1; generation -= 1) {
        const from = rotatedPath(this.#path, generation);
        if (existsSync(from)) {
          renameSync(from, rotatedPath(this.#path, generation + 1));
        }
      }
      renameSync(this.#path, rotatedPath(this.#path, 1));
    }
    appendFileSync(this.#path, "", { mode: 0o600 });
    chmodSync(this.#path, 0o600);
    this.#length = 0;
  }

  /** Seal `line` (a trailing newline is dropped) and append it. */
  append(line: string): void {
    const sealed = `${sealLogLine(this.#key, line.replace(/[\r\n]+$/, ""))}\n`;
    const size = Buffer.byteLength(sealed);
    if (this.#length > 0 && this.#length + size > this.#maxBytes) {
      this.#rotate();
    }
    appendFileSync(this.#path, sealed);
    this.#length += size;
  }
}

function linesOf(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function present(key: LogKey, line: string): string {
  if (line.startsWith(SEALED_LINE_PREFIX)) {
    return openLogLine(key, line) ?? UNREADABLE;
  }
  return scrubText(line);
}

/** The last `count` lines, oldest first, reaching into the newest rotated file when short. */
export function readSealedTail(
  path: string,
  key: LogKey,
  count: number,
): string[] {
  let lines = linesOf(path);
  if (lines.length < count) {
    lines = [...linesOf(rotatedPath(path, 1)), ...lines];
  }
  return lines
    .slice(Math.max(0, lines.length - count))
    .map((line) => present(key, line));
}

/**
 * Seal every line an older build wrote in the clear, in place and atomically
 * (a sibling is written owner-only, then renamed over). Returns how many.
 */
export function sealExistingLog(path: string, key: LogKey): number {
  const lines = linesOf(path);
  const legacy = lines.filter((line) => !line.startsWith(SEALED_LINE_PREFIX));
  if (legacy.length === 0) return 0;
  const staging = `${path}.sealing`;
  rmSync(staging, { force: true });
  const fd = openSync(staging, "wx", 0o600);
  try {
    for (const line of lines) {
      const out = line.startsWith(SEALED_LINE_PREFIX)
        ? line
        : sealLogLine(key, scrubText(line));
      writeSync(fd, `${out}\n`);
    }
  } finally {
    closeSync(fd);
  }
  renameSync(staging, path);
  return legacy.length;
}

/** Where the key for `logPath` lives: the override, else `<logPath>.key`. */
export function logKeyPath(logPath: string, override?: string): string {
  return override ? override : `${logPath}.key`;
}

/**
 * A pino destination that seals every line into `logPath`. Throws when the
 * file or key cannot be opened.
 */
export function createSealedLogDestination(
  logPath: string,
  keyOverride?: string,
): LogDestination {
  const key = loadOrCreateLogKey(logKeyPath(logPath, keyOverride));
  sealExistingLog(logPath, key);
  const file = new SealedLogFile(logPath, key);
  return { write: (message) => file.append(message) };
}
