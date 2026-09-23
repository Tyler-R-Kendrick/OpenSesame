/**
 * Install the runtime contract into a bare isolate (ADR 0133 §6). A browser
 * or Node already provides every global here; an isolate such as Android's
 * JavaScriptSandbox provides only the ECMAScript built-ins. This fills the
 * gap — `crypto.subtle` (noble), `TextEncoder`/`TextDecoder`, `atob`/`btoa`,
 * `URL`/`URLSearchParams` (whatwg-url) — and never replaces a global the
 * isolate already has.
 *
 * Randomness is the embedder's alone. The contract never ships a generator of
 * its own: `crypto.getRandomValues` calls the source the embedder hands in
 * (on Android, a `SecureRandom` bridge), and with none it throws, so nothing
 * that needs a nonce or a key can proceed on made-up entropy.
 */
import "./codecs-first.js";
import { URLSearchParams as WhatwgParams, URL as WhatwgUrl } from "whatwg-url";
import { sandboxSubtle } from "./subtle.js";
import {
  SandboxTextDecoder,
  SandboxTextEncoder,
  sandboxAtob,
  sandboxBtoa,
} from "./text.js";

export type EntropySource = <T extends ArrayBufferView | null>(array: T) => T;

export type RuntimeContractOptions = Readonly<{
  /** Fills a typed array with cryptographically secure random bytes. */
  getRandomValues?: EntropySource;
  /** The embedder's timers, where it has an event loop to run them. */
  timers?: Readonly<{
    setTimeout: (handler: () => void, ms?: number) => number | object;
    clearTimeout: (handle: number | object | undefined) => void;
  }>;
}>;

const MAX_RANDOM_BYTES = 65_536;

function randomValues(source: EntropySource | undefined): EntropySource {
  return (array) => {
    if (!source)
      throw new Error("sandbox: the embedder provided no entropy source");
    if (array !== null && array.byteLength > MAX_RANDOM_BYTES) {
      const error = new Error("getRandomValues: more than 65536 bytes");
      error.name = "QuotaExceededError";
      throw error;
    }
    return source(array);
  };
}

function randomUUID(fill: EntropySource): () => string {
  return () => {
    const bytes = fill(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4),
      hex.slice(4, 6),
      hex.slice(6, 8),
      hex.slice(8, 10),
      hex.slice(10),
    ]
      .map((part) => part.join(""))
      .join("-");
  };
}

type Target = Record<string, unknown>;

function define(target: Target, name: string, value: unknown, out: string[]) {
  if (target[name] !== undefined) return;
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  out.push(name);
}

/** Installs what is missing; returns the names it installed. */
export function installRuntimeContract(
  target: object = globalThis,
  options: RuntimeContractOptions = {},
): string[] {
  const scope = target as Target;
  const installed: string[] = [];
  const fill = randomValues(options.getRandomValues);
  define(
    scope,
    "crypto",
    {
      subtle: sandboxSubtle,
      getRandomValues: fill,
      randomUUID: randomUUID(fill),
    },
    installed,
  );
  define(scope, "TextEncoder", SandboxTextEncoder, installed);
  define(scope, "TextDecoder", SandboxTextDecoder, installed);
  define(scope, "atob", sandboxAtob, installed);
  define(scope, "btoa", sandboxBtoa, installed);
  define(scope, "URL", WhatwgUrl, installed);
  define(scope, "URLSearchParams", WhatwgParams, installed);
  if (options.timers) {
    define(scope, "setTimeout", options.timers.setTimeout, installed);
    define(scope, "clearTimeout", options.timers.clearTimeout, installed);
  }
  return installed;
}

/**
 * The master password is NFKC-normalised before derivation, so an isolate
 * built without Unicode normalisation would derive a different key for some
 * passwords. Refuse such a host outright rather than fail on one password.
 */
export function assertHostIntl(): void {
  const normalizes =
    typeof "".normalize === "function" &&
    "Ａ①".normalize("NFKC") === "A1" &&
    "é".normalize("NFC") === "é";
  if (!normalizes)
    throw new Error(
      "sandbox: this isolate cannot normalise Unicode (NFKC); vault passwords would derive the wrong key",
    );
}
