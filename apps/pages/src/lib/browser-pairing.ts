import {
  createDpopKeyPair,
  normalizeHttpBaseUrl,
} from "@opensesame/api-client";
import { type BoundaryValue, isNumber, isString } from "@opensesame/os-domain";
import { readBoundedObject } from "./bounded-response.js";
import { mayPairLocalAuthority } from "./deployment-profile.js";
import { localNetworkFetch } from "./local-network-fetch.js";

export class BrowserPairingError extends Error {
  constructor(
    readonly code:
      | "restricted_demo"
      | "pairing_required"
      | "pairing_failed"
      | "pairing_expired",
  ) {
    super(
      code === "restricted_demo"
        ? "This shared-origin demo cannot connect to local authority. Use a dedicated or loopback deployment."
        : code === "pairing_required"
          ? "Pair this browser with the Host using its local approval ceremony."
          : code,
    );
    this.name = "BrowserPairingError";
  }
}

type ProofKey = Awaited<ReturnType<typeof createDpopKeyPair>>;
export type BrowserGrant = {
  clientId: string;
  hostApi: string;
  expiresAt: number;
  capabilities: string[];
};
export type PairingPrompt = {
  pairingId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
};
type Pending = {
  hostApi: string;
  key: ProofKey;
  deviceCode: string;
  prompt: PairingPrompt;
  nextPoll: number;
  epoch: number;
};
let pending: Pending | null = null;
let grant: (BrowserGrant & { key: ProofKey; accessToken: string }) | null =
  null;
let epoch = 0;
let lifetime = new AbortController();

export const browserPairingSeams = {
  eligible: mayPairLocalAuthority,
  createKey: createDpopKeyPair,
};
export function browserPairingSignal(): AbortSignal {
  return lifetime.signal;
}
function assertEligible(): void {
  if (!browserPairingSeams.eligible())
    throw new BrowserPairingError("restricted_demo");
}
function baseUrl(raw: string): string {
  const base = normalizeHttpBaseUrl(raw);
  if (!base) throw new BrowserPairingError("pairing_failed");
  return base;
}

async function body(response: Response) {
  try {
    return await readBoundedObject(response, 16384, 8000);
  } catch {
    throw new BrowserPairingError("pairing_failed");
  }
}

async function pairingRequest(
  hostApi: string,
  path: string,
  key: ProofKey,
  payload: BoundaryValue,
  signal: AbortSignal,
) {
  const url = `${hostApi}${path}`;
  const proof = await key.createDpopProof(url, "POST");
  if (signal.aborted) throw new BrowserPairingError("pairing_expired");
  return localNetworkFetch(url, {
    signal,
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      DPoP: proof,
    },
    body: JSON.stringify(payload),
    timeoutMs: 8000,
  });
}

/** Explicit user action starts a single tab-owned pairing. Secrets never enter this public prompt. */
export async function beginBrowserPairing(
  rawHost: string,
): Promise<PairingPrompt> {
  assertEligible();
  clearBrowserPairing();
  const generation = epoch;
  const signal = lifetime.signal;
  const hostApi = baseUrl(rawHost);
  const key = await browserPairingSeams.createKey();
  if (epoch !== generation) throw new BrowserPairingError("pairing_expired");
  const response = await pairingRequest(
    hostApi,
    "/api/v1/browser-pairings",
    key,
    { capabilities: ["host.sync.read", "host.sync.write"] },
    signal,
  );
  if (!response.ok) throw new BrowserPairingError("pairing_failed");
  const value = await body(response);
  const { prompt, deviceCode } = validatedPrompt(value, hostApi);
  if (epoch !== generation) throw new BrowserPairingError("pairing_expired");
  pending = {
    hostApi,
    key,
    deviceCode,
    prompt,
    nextPoll: Date.now(),
    epoch: generation,
  };
  return prompt;
}

/** One bounded poll. The UI schedules subsequent polls at the advertised interval. */
export async function pollBrowserPairing(): Promise<BrowserGrant | null> {
  assertEligible();
  const active = pending;
  if (
    !active ||
    active.epoch !== epoch ||
    active.prompt.expiresAt <= Date.now()
  )
    throw new BrowserPairingError("pairing_expired");
  if (active.nextPoll > Date.now()) return null;
  active.nextPoll = Date.now() + active.prompt.interval * 1000;
  const response = await pairingRequest(
    active.hostApi,
    "/api/v1/browser-pairings/token",
    active.key,
    { device_code: active.deviceCode },
    lifetime.signal,
  );
  const value = await body(response);
  if (pending !== active || epoch !== active.epoch)
    throw new BrowserPairingError("pairing_expired");
  if (!response.ok) {
    if (value.error === "slow_down") {
      active.prompt.interval = Math.min(60, active.prompt.interval + 5);
      active.nextPoll = Date.now() + active.prompt.interval * 1000;
    }
    if (value.error === "authorization_pending" || value.error === "slow_down")
      return null;
    clearBrowserPairing();
    throw new BrowserPairingError("pairing_failed");
  }
  const validated = validatedToken(value);
  grant = {
    hostApi: active.hostApi,
    key: active.key,
    ...validated,
  };
  pending = null;
  return currentBrowserGrant(active.hostApi);
}

export function clearBrowserPairing(): void {
  lifetime.abort();
  lifetime = new AbortController();
  epoch += 1;
  pending = null;
  grant = null;
}

export function currentBrowserGrant(rawHost: string): BrowserGrant | null {
  if (grant && grant.expiresAt <= Date.now()) clearBrowserPairing();
  if (
    !rawHost ||
    !browserPairingSeams.eligible() ||
    !grant ||
    grant.expiresAt <= Date.now() ||
    grant.hostApi !== baseUrl(rawHost)
  )
    return null;
  return {
    hostApi: grant.hostApi,
    clientId: grant.clientId,
    expiresAt: grant.expiresAt,
    capabilities: [...grant.capabilities],
  };
}

export async function pairedHostFetch(
  rawHost: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  assertEligible();
  const hostApi = baseUrl(rawHost);
  const active = grant;
  const signal = requestSignal(init.signal);
  if (!currentBrowserGrant(hostApi) || !active)
    throw new BrowserPairingError("pairing_required");
  const url = pairedUrl(hostApi, path);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.delete("X-OpenSesame-Operator");
  headers.set("Authorization", `DPoP ${active.accessToken}`);
  headers.set(
    "DPoP",
    await active.key.createDpopProof(url, method, active.accessToken),
  );
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (grant !== active) throw new BrowserPairingError("pairing_expired");
  const request = {
    ...init,
    signal,
    headers,
    credentials: "omit" as const,
    redirect: "error" as const,
    timeoutMs: 8000,
  };
  let response = await localNetworkFetch(url, request);
  const nonce = response.headers.get("DPoP-Nonce");
  if (nonceRetry(active, response.status, nonce)) {
    await response.body?.cancel();
    headers.set(
      "DPoP",
      await active.key.createDpopProof(url, method, active.accessToken, nonce),
    );
    if (grant !== active) throw new BrowserPairingError("pairing_expired");
    response = await localNetworkFetch(url, request);
  }
  if (response.status === 401) clearBrowserPairing();
  if (staleResponse(active, response.status)) {
    await response.body?.cancel();
    throw new BrowserPairingError("pairing_expired");
  }
  return response;
}

function staleResponse(active: typeof grant, status: number) {
  return grant !== active && status !== 401;
}

function nonceRetry(
  active: typeof grant,
  status: number,
  nonce: string | null,
): nonce is string {
  return status === 401 && !!nonce && nonce.length <= 256 && grant === active;
}

function requestSignal(signal: AbortSignal | null | undefined) {
  return signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
}

export async function revokeBrowserPairing(rawHost: string): Promise<void> {
  const active = currentBrowserGrant(rawHost);
  try {
    if (active) {
      const response = await pairedHostFetch(
        rawHost,
        `/api/v1/browser-clients/${encodeURIComponent(active.clientId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new BrowserPairingError("pairing_failed");
    }
  } finally {
    clearBrowserPairing();
  }
}

function validatedPrompt(
  value: Awaited<ReturnType<typeof body>>,
  hostApi: string,
) {
  if (
    !isString(value.pairing_id) ||
    !isString(value.device_code) ||
    value.device_code.length < 32 ||
    !isString(value.user_code) ||
    !/^[A-Z0-9-]{6,32}$/.test(value.user_code) ||
    !isString(value.verification_uri) ||
    !isNumber(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 300 ||
    !isNumber(value.interval) ||
    value.interval < 1 ||
    value.interval > 30
  )
    throw new BrowserPairingError("pairing_failed");
  const verification = verificationUrl(value.verification_uri, hostApi);
  const prompt: PairingPrompt = {
    pairingId: value.pairing_id,
    userCode: value.user_code,
    verificationUri: verification.href,
    expiresAt: Date.now() + value.expires_in * 1000,
    interval: value.interval,
  };
  return { prompt, deviceCode: value.device_code };
}

function validatedToken(value: Awaited<ReturnType<typeof body>>) {
  if (
    value.token_type !== "DPoP" ||
    !isString(value.access_token) ||
    value.access_token.length < 32 ||
    value.access_token.length > 4096 ||
    !isString(value.client_id) ||
    !value.client_id ||
    value.client_id.length > 128 ||
    !isNumber(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 300 ||
    !isString(value.scope)
  )
    throw new BrowserPairingError("pairing_failed");
  const capabilities = value.scope.split(" ");
  if (
    !capabilities.length ||
    capabilities.some(
      (capability) =>
        !["host.sync.read", "host.sync.write"].includes(capability),
    )
  )
    throw new BrowserPairingError("pairing_failed");
  return {
    accessToken: value.access_token,
    clientId: value.client_id,
    expiresAt: Date.now() + value.expires_in * 1000,
    capabilities,
  };
}

function pairedUrl(hostApi: string, path: string) {
  if (!path.startsWith("/api/v1/") || path.includes("\\") || path.includes("#"))
    throw new BrowserPairingError("pairing_failed");
  const url = `${hostApi}${path}`;
  if (new URL(url).pathname !== path.split("?")[0] || /%2e|%2f|%5c/i.test(path))
    throw new BrowserPairingError("pairing_failed");
  return url;
}

function verificationUrl(raw: string, hostApi: string) {
  const verification = new URL(raw);
  if (
    verification.origin !== new URL(hostApi).origin ||
    verification.search ||
    verification.hash ||
    verification.username ||
    verification.password
  )
    throw new BrowserPairingError("pairing_failed");
  return verification;
}
