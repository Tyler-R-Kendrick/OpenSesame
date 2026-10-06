/**
 * An encrypted, rotating log file for the TypeScript services (ADR 0157).
 *
 * The same format as `crates/sealed-log`, so one reader opens both. Each
 * `osl2.` envelope wraps a fresh data key for its line,
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
import {
  LEGACY_LINE_PREFIX,
  type LogKey,
  SEALED_LINE_PREFIX,
  bindLogKeyPath,
  openLogLine,
  sealLogLine,
} from "./sealed-log-cipher.js";
export {
  SEALED_LINE_PREFIX,
  type LogKey,
  openLogLine,
  sealLogLine,
} from "./sealed-log-cipher.js";
import { scrubText } from "@opensesame/log-scrub";

/** What stands in for a sealed line that does not open. */
export const UNREADABLE = "[sealed line: not readable with this key]";
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP = 3;

function fromHex(text: string): Uint8Array | undefined {
  const clean = text.trim();
  if (!/^[0-9a-f]{64}$/i.test(clean)) return undefined;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

/** Read the key at `path` without creating one. */
export function loadLogKey(path: string): LogKey {
  const key = fromHex(readFileSync(path, "utf8"));
  if (!key) throw new Error(`${path} does not hold a 32-byte hex log key`);
  return bindLogKeyPath(key, path);
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
    return bindLogKeyPath(key, path);
  } catch (error) {
    // Another process published its key first: use that one.
    if (existsSync(path)) return loadLogKey(path);
    throw error;
  } finally {
    rmSync(staging, { force: true });
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

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return 0;
    throw error;
  }
}

function isMissing(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

/** Rename `from` to `to`; a `from` another process already moved is not an error. */
function shift(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!(error instanceof Error && isMissing(error))) throw error;
  }
}

/**
 * The file lines are sealed into: owner-only, rotating whole files. Several
 * processes may share one path, so nothing about the file is remembered: each
 * line reads the file's real size, and the file is opened by path each time, so
 * a line never lands in a generation another process renamed.
 */
export class SealedLogFile {
  readonly #path: string;
  readonly #key: LogKey;
  readonly #maxBytes: number;
  readonly #keep: number;

  constructor(path: string, key: LogKey, options: SealedLogOptions = {}) {
    this.#path = path;
    this.#key = key;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#keep = options.keep ?? DEFAULT_KEEP;
    sealExistingLog(path, key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "", { mode: 0o600 });
    // `mode` applies only when the file is created; one an older build left
    // wider is narrowed here.
    chmodSync(path, 0o600);
  }

  #rotate(needed: number): void {
    // Another process may have rotated while this line was being sealed.
    if (sizeOf(this.#path) + needed <= this.#maxBytes) return;
    if (this.#keep === 0) {
      rmSync(this.#path, { force: true });
      return;
    }
    for (let generation = this.#keep - 1; generation >= 1; generation -= 1) {
      shift(
        rotatedPath(this.#path, generation),
        rotatedPath(this.#path, generation + 1),
      );
    }
    shift(this.#path, rotatedPath(this.#path, 1));
  }

  #write(sealed: string): void {
    const size = Buffer.byteLength(sealed);
    const length = sizeOf(this.#path);
    if (length > 0 && length + size > this.#maxBytes) this.#rotate(size);
    // `mode` so a file recreated after a rotation is never umask-mode.
    appendFileSync(this.#path, sealed, { mode: 0o600 });
  }

  /**
   * Seal `line` (a trailing newline is dropped) and append it. A lost race with
   * another process's rotation is retried once against the fresh path; a line
   * that still cannot be written is dropped rather than thrown into the logger.
   */
  append(line: string): void {
    const sealed = `${sealLogLine(this.#key, line.replace(/[\r\n]+$/, ""))}\n`;
    try {
      this.#write(sealed);
    } catch {
      try {
        this.#write(sealed);
      } catch {
        // Logging must not take the service down.
      }
    }
  }
}

function linesOf(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function present(key: LogKey, line: string): string {
  if (/^osl\d+\./u.test(line.trim())) {
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

/** How many rotated generations beside the live file are looked for. */
const MAX_ROTATED_SCAN = 64;

function sealOneLog(path: string, key: LogKey): number {
  const lines = linesOf(path);
  for (const line of lines) {
    if (/^osl\d+\./u.test(line.trim()) && openLogLine(key, line) === null)
      throw new Error("Sealed log line cannot be opened");
  }
  const legacy = lines.filter(
    (line) => !line.trim().startsWith(SEALED_LINE_PREFIX),
  );
  if (legacy.length === 0) return 0;
  const staging = `${path}.sealing`;
  rmSync(staging, { force: true });
  const fd = openSync(staging, "wx", 0o600);
  try {
    for (const line of lines) {
      let out = line;
      if (line.trim().startsWith(LEGACY_LINE_PREFIX)) {
        const plain = openLogLine(key, line);
        if (plain === null)
          throw new Error("Legacy sealed log line cannot be opened");
        out = sealLogLine(key, plain);
      } else if (!line.trim().startsWith(SEALED_LINE_PREFIX)) {
        if (/^osl\d+\./u.test(line.trim()))
          throw new Error("Unknown sealed log version");
        out = sealLogLine(key, scrubText(line));
      }
      writeSync(fd, `${out}\n`);
    }
  } finally {
    closeSync(fd);
  }
  renameSync(staging, path);
  return legacy.length;
}

/**
 * Seal every line an older build wrote in the clear, in place and atomically
 * (a sibling is written owner-only, then renamed over), in the live file and in
 * every rotated generation beside it (`path.1`, `path.2`, ...). Returns how many.
 */
export function sealExistingLog(path: string, key: LogKey): number {
  let sealed = sealOneLog(path, key);
  for (let generation = 1; generation <= MAX_ROTATED_SCAN; generation += 1) {
    sealed += sealOneLog(rotatedPath(path, generation), key);
  }
  return sealed;
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
  const keyPath = logKeyPath(logPath, keyOverride);
  const paths = [
    logPath,
    ...Array.from({ length: MAX_ROTATED_SCAN }, (_, index) =>
      rotatedPath(logPath, index + 1),
    ),
  ];
  const hasSealed = paths.some((path) =>
    linesOf(path).some((line) => /^osl\d+\./u.test(line.trim())),
  );
  if (!existsSync(keyPath) && hasSealed)
    throw new Error(
      "Sealed log key is missing; refusing to generate a replacement",
    );
  const key = hasSealed ? loadLogKey(keyPath) : loadOrCreateLogKey(keyPath);
  const file = new SealedLogFile(logPath, key);
  return { write: (message) => file.append(message) };
}
