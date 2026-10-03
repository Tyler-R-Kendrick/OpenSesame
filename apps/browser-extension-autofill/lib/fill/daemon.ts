/**
 * The extension's client for the daemon's fill routes (`crates/daemon`
 * `src/fill`). The daemon is loopback only; the browser stamps this
 * extension's own `Origin` on every call, and the pairing token rides as a
 * bearer. Every answer is decoded (`wire.ts`) before it is used. Nothing here
 * logs, caches or stores a value: `value()` hands the one field straight back
 * to its caller.
 */
import type * as z from "zod/mini";
import { DAEMON_BASE } from "../sites/patterns";
import type { FillField } from "./guard";
import {
  type PairState,
  daemonMatch,
  daemonRefusal,
  daemonValue,
  pairState,
} from "./wire";

/** The pairing token's key in `storage.local`. It admits fill, not values. */
export const TOKEN_KEY = "fillPairingToken";

/** A refusal from the daemon, by its stable code. Never carries a value. */
export class FillError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "FillError";
    this.code = code;
  }
}

export interface DaemonClient {
  pair(): Promise<PairState>;
  match(origin: string): Promise<readonly string[]>;
  value(reference: string, origin: string, field: FillField): Promise<string>;
}

/** A string-valued store; whatever else a key holds reads as absent. */
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** 32 random bytes as unpadded base64url: the 43 characters the daemon wants. */
export function newToken(random: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = random(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const TOKEN_FORM = /^[A-Za-z0-9_-]{43,128}$/;

/** This install's pairing token, minted on first use. */
export async function pairingToken(
  store: KeyValueStore,
  random: (bytes: Uint8Array) => Uint8Array,
): Promise<string> {
  const stored = await store.get(TOKEN_KEY);
  if (stored !== undefined && TOKEN_FORM.test(stored)) return stored;
  const token = newToken(random);
  await store.set(TOKEN_KEY, token);
  return token;
}

/**
 * The daemon's refusal code. A bare 404 is the one answer that carries none:
 * the `browser-autofill` plugin is off, and the daemon answers the fill
 * routes exactly as it answers a path it never served (ADR 0150 §7).
 */
async function errorCode(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (response.status === 404 && text === "") return "plugin_off";
  try {
    const refusal = daemonRefusal.safeParse(JSON.parse(text));
    if (refusal.success) return refusal.data.error;
  } catch {
    // not JSON: fall through to the status
  }
  return `http_${response.status}`;
}

/** What a fill route is sent: nothing, an origin, or a fill's three facts. */
interface DaemonBody {
  readonly origin?: string;
  readonly reference?: string;
  readonly field?: FillField;
}

export interface DaemonClientOptions {
  readonly token: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly base?: string;
}

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.base ?? DAEMON_BASE;

  async function post<T>(
    path: string,
    body: DaemonBody,
    decode: z.ZodMiniType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await options.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      throw new FillError("daemon_unreachable");
    }
    if (!response.ok) {
      throw new FillError(await errorCode(response));
    }
    const decoded = decode.safeParse(await response.json().catch(() => null));
    if (!decoded.success) throw new FillError("unexpected_response");
    return decoded.data;
  }

  return {
    pair: () => post("/v1/fill/pair", {}, pairState),
    async match(origin) {
      const body = await post("/v1/fill/match", { origin }, daemonMatch);
      return body.references.filter(
        (reference): reference is string => reference !== undefined,
      );
    },
    async value(reference, origin, field) {
      const body = await post(
        "/v1/fill",
        { reference, origin, field },
        daemonValue,
      );
      if (body.field !== field) throw new FillError("unexpected_response");
      return body.value;
    },
  };
}
