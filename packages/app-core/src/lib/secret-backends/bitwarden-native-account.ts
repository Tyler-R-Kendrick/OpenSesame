import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type BitwardenNativeKey,
  decodeBitwardenKey,
} from "./bitwarden-native-cose.js";
import { openBitwardenAccountKeyEnvelope } from "./bitwarden-native-envelope.js";
import {
  type BitwardenKdfResourceLimits,
  deriveBitwardenMasterKey,
} from "./bitwarden-native-kdf.js";
import {
  type BitwardenNativeCredentials,
  type BitwardenPasswordUnlock,
  bitwardenAccountIdentity,
  bitwardenProtocolError,
  decodeBitwardenPrelogin,
  decodeBitwardenSync,
  decodeBitwardenToken,
} from "./bitwarden-native-protocol.js";
import { secretBackendUrl } from "./http.js";
import type { SecretBackendTransport } from "./transport.js";
import { SecretBackendError } from "./types.js";

const MAX_SYNC_BYTES = 64 * 1024 * 1024;
const MAX_AUTH_BYTES = 64 * 1024;
class NativeHttpError extends SecretBackendError {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403 ? "authentication" : "response",
      `The native Bitwarden request failed (HTTP ${status}).`,
    );
  }
}
function current(transport: SecretBackendTransport, signal: AbortSignal): void {
  transport.assertCurrent();
  if (signal.aborted)
    throw new SecretBackendError(
      "stale",
      "The native account operation has ended.",
    );
}
function closeBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    return;
  }
}
async function readJson(
  response: Response,
  maximum: number,
  transport: SecretBackendTransport,
  signal: AbortSignal,
): Promise<BoundaryValue> {
  const reader = response.body?.getReader();
  if (!reader) throw bitwardenProtocolError();
  let complete = false;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    current(transport, signal);
    for (;;) {
      const part = await reader.read();
      current(transport, signal);
      if (part.done) {
        complete = true;
        break;
      }
      size += part.value.byteLength;
      if (!part.value.byteLength || size > maximum || chunks.length >= 65536)
        throw bitwardenProtocolError();
      chunks.push(new Uint8Array(part.value));
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw bitwardenProtocolError();
    } finally {
      bytes.fill(0);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) abort();
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}
function validateReply(response: Response, maximum: number): void {
  const media = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const length = response.headers.get("content-length");
  if (
    response.redirected ||
    !/^application\/(?:json|[a-z0-9!#$%&'*+.^_`|~-]+\+json)$/.test(
      media ?? "",
    ) ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
  )
    throw bitwardenProtocolError();
}
/** An encrypted-protocol request owner: no ambient fetch, cookies or redirects. */
function nativeHttp(
  baseUrl: string,
  transport: SecretBackendTransport,
  owner: AbortSignal,
) {
  const base = secretBackendUrl(baseUrl);
  return async (
    path: string,
    init: RequestInit,
    maximum = MAX_AUTH_BYTES,
  ): Promise<BoundaryValue> => {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw bitwardenProtocolError();
    const signal = AbortSignal.any([
      transport.signal,
      owner,
      AbortSignal.timeout(20000),
    ]);
    current(transport, signal);
    let response: Response;
    try {
      response = await transport.fetch(url, {
        ...init,
        signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      current(transport, signal);
      if (error instanceof SecretBackendError) throw error;
      throw new SecretBackendError(
        "network",
        "Could not reach the configured native Bitwarden endpoint.",
      );
    }
    try {
      current(transport, signal);
      if (!response.ok) throw new NativeHttpError(response.status);
      validateReply(response, maximum);
      return await readJson(response, maximum, transport, signal);
    } catch (error) {
      closeBody(response);
      throw error;
    }
  };
}
function tokenForm(config: BitwardenNativeCredentials): URLSearchParams {
  return new URLSearchParams({
    grant_type: "client_credentials",
    scope: "api",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    deviceType: "14",
    deviceIdentifier: config.deviceIdentifier,
    deviceName: "OpenSesame PWA",
  });
}
async function prelogin(request: ReturnType<typeof nativeHttp>, email: string) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  };
  try {
    return decodeBitwardenPrelogin(
      await request("accounts/prelogin/password", init),
      email,
    );
  } catch (error) {
    if (
      !(error instanceof NativeHttpError) ||
      ![404, 405].includes(error.status)
    )
      throw error;
    return decodeBitwardenPrelogin(
      await request("accounts/prelogin", init),
      email,
    );
  }
}
async function unlockUserKey(
  unlock: BitwardenPasswordUnlock,
  password: string,
  limits: BitwardenKdfResourceLimits,
  check: () => void,
): Promise<BitwardenNativeKey> {
  const salt = new TextEncoder().encode(unlock.salt);
  let master: Uint8Array | undefined;
  let raw: Uint8Array | undefined;
  let key: BitwardenNativeKey | undefined;
  try {
    master = await deriveBitwardenMasterKey(password, salt, unlock.kdf, limits);
    check();
    raw = openBitwardenAccountKeyEnvelope(unlock.wrappedKey, master);
    key = decodeBitwardenKey(raw);
    const usable =
      key.algorithm === -70010
        ? key.operations.includes(6)
        : key.algorithm === -70011 && key.operations.includes(4);
    if (!usable) throw bitwardenProtocolError();
    return key;
  } catch (error) {
    key?.material.fill(0);
    key?.id.fill(0);
    if (error instanceof SecretBackendError) throw error;
    throw new SecretBackendError(
      "authentication",
      "Could not unlock the authenticated account key.",
    );
  } finally {
    master?.fill(0);
    raw?.fill(0);
    salt.fill(0);
  }
}
export type BitwardenNativeAccount = {
  /** Internal worker-owned material; this is never a public SecretBackendSession. */
  readonly key: BitwardenNativeKey;
  readonly signal: AbortSignal;
  sync(): Promise<BoundaryValue[]>;
  dispose(): void;
};
function syncedCiphers(
  fetchSync: () => Promise<ReturnType<typeof decodeBitwardenSync>>,
  unlock: BitwardenPasswordUnlock,
  check: () => void,
  dispose: () => void,
) {
  return async () => {
    try {
      const next = await fetchSync();
      check();
      if (JSON.stringify(next.unlock) !== JSON.stringify(unlock))
        throw bitwardenProtocolError();
      return next.ciphers;
    } catch (error) {
      dispose();
      throw error;
    }
  };
}
function validatePassword(password: string): void {
  if (!z.string().min(1).max(4096).safeParse(password).success)
    throw new SecretBackendError(
      "configuration",
      "Enter the master password for this connection.",
    );
}
/** Personal API authentication plus authenticated sync binding and actual local key unlock. */
export async function openBitwardenNativeAccount(
  input: BitwardenNativeCredentials,
  password: string,
  limits: BitwardenKdfResourceLimits,
  transport: SecretBackendTransport,
): Promise<BitwardenNativeAccount> {
  validatePassword(password);
  let config: BitwardenNativeCredentials | undefined = { ...input };
  bitwardenAccountIdentity(config);
  const owner = new AbortController();
  const identity = nativeHttp(config.identityUrl, transport, owner.signal);
  const api = nativeHttp(config.baseUrl, transport, owner.signal);
  const signal = AbortSignal.any([transport.signal, owner.signal]);
  let token: ReturnType<typeof decodeBitwardenToken> | undefined;
  let refresh: Promise<void> | undefined;
  let expiresAt = 0;
  let key: BitwardenNativeKey | undefined;
  const dispose = () => {
    signal.removeEventListener("abort", dispose);
    owner.abort();
    config = undefined;
    token = undefined;
    expiresAt = 0;
    key?.material.fill(0);
    key?.id.fill(0);
    key = undefined;
  };
  signal.addEventListener("abort", dispose, { once: true });
  const renew = async () => {
    current(transport, signal);
    if (!config)
      throw new SecretBackendError(
        "locked",
        "The native account was disconnected.",
      );
    const result = decodeBitwardenToken(
      await identity("connect/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm(config),
      }),
    );
    current(transport, signal);
    token = result;
    expiresAt = Date.now() + result.expiresIn * 1000;
  };
  const ensureToken = async () => {
    current(transport, signal);
    if (token && Date.now() < expiresAt - 5000) return;
    refresh ??= renew().finally(() => {
      refresh = undefined;
    });
    await refresh;
    current(transport, signal);
  };
  try {
    const settings = await prelogin(
      identity,
      config.email.trim().toLowerCase(),
    );
    await ensureToken();
    const fetchSync = async () => {
      await ensureToken();
      if (!config || !token) throw bitwardenProtocolError();
      const issued = token;
      const reply = await api(
        "sync?excludeDomains=true",
        {
          headers: { authorization: `Bearer ${issued.token}` },
        },
        MAX_SYNC_BYTES,
      );
      current(transport, signal);
      return decodeBitwardenSync(reply, issued.raw, config, settings);
    };
    const { unlock } = await fetchSync();
    current(transport, signal);
    key = await unlockUserKey(unlock, password, limits, () =>
      current(transport, signal),
    );
    current(transport, signal);
    return {
      key,
      signal,
      dispose,
      sync: syncedCiphers(
        fetchSync,
        unlock,
        () => current(transport, signal),
        dispose,
      ),
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
