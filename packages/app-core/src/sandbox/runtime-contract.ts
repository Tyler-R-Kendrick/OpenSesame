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

type TimerHandle = ReturnType<typeof setTimeout>;

export type RuntimeContractOptions = Readonly<{
  /** Fills a typed array with cryptographically secure random bytes. */
  getRandomValues?: EntropySource;
  /** The embedder's timers, where it has an event loop to run them. */
  timers?: Readonly<{
    setTimeout: (handler: () => void, ms?: number) => TimerHandle;
    clearTimeout: (handle: TimerHandle | undefined) => void;
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

/** Installs what is missing; returns the names it installed. */
export function installRuntimeContract(
  target: typeof globalThis = globalThis,
  options: RuntimeContractOptions = {},
): string[] {
  const fill = randomValues(options.getRandomValues);
  const contract = {
    crypto: {
      subtle: sandboxSubtle,
      getRandomValues: fill,
      randomUUID: randomUUID(fill),
    },
    TextEncoder: SandboxTextEncoder,
    TextDecoder: SandboxTextDecoder,
    atob: sandboxAtob,
    btoa: sandboxBtoa,
    URL: WhatwgUrl,
    URLSearchParams: WhatwgParams,
    ...options.timers,
  };
  const installed: string[] = [];
  for (const [name, value] of Object.entries(contract)) {
    if (name in target) continue;
    Object.defineProperty(target, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    installed.push(name);
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
    "normalize" in String.prototype &&
    "Ａ①".normalize("NFKC") === "A1" &&
    "é".normalize("NFC") === "é";
  if (!normalizes)
    throw new Error(
      "sandbox: this isolate cannot normalise Unicode (NFKC); vault passwords would derive the wrong key",
    );
}
