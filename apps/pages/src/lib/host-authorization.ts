import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { isLoopbackOrigin } from "@opensesame/static-auth";
import { readBoundedObject } from "./bounded-response.js";
import {
  browserPairingSignal,
  currentBrowserGrant,
} from "./browser-pairing.js";
import { hostFetch, identityBase } from "./identity.js";
import { loadSettings } from "./settings.js";

export type ControlTransition = "handoff" | "take" | "release";
export type HostAuthorizationRequest =
  | { operation: "browser.authenticate"; target_id: string; transition: null }
  | {
      operation: "agent.browser.control";
      target_id: string;
      transition: ControlTransition;
    };

export class HostAuthorizationError extends Error {
  constructor() {
    super(
      "Identity verification was refused or expired. Check your Identity sign-in and passkey, then try again.",
    );
    this.name = "HostAuthorizationError";
  }
}

export const hostAuthorizationSeams = {
  open: (url: string) =>
    window.open(url, "_blank", "popup,width=540,height=680"),
  hostFetch,
  identityBase,
  pairingSignal: browserPairingSignal,
};

async function read(response: Response): Promise<BoundaryValue> {
  if (!response.ok) throw new HostAuthorizationError();
  try {
    return await readBoundedObject(response, 20000, 10000);
  } catch {
    throw new HostAuthorizationError();
  }
}

function stateValue() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Call directly from a user gesture. The Identity-origin window owns WebAuthn. */
export async function authorizeHost(
  request: HostAuthorizationRequest,
  cancellation: AbortSignal,
): Promise<string | null> {
  const identity = new URL(hostAuthorizationSeams.identityBase());
  validateIdentityUrl(identity);
  const lifetime = AbortSignal.any([
    cancellation,
    hostAuthorizationSeams.pairingSignal(),
    AbortSignal.timeout(300000),
  ]);
  lifetime.throwIfAborted();
  const state = stateValue();
  const url = new URL(
    `${identity.href.replace(/\/$/, "")}/v1/host-authorizations/ceremony`,
  );
  url.searchParams.set("origin", location.origin);
  url.searchParams.set("state", state);
  const popup = hostAuthorizationSeams.open(url.href);
  if (!popup) throw new HostAuthorizationError();
  try {
    const assertion = await exchange(
      popup,
      identity.origin,
      state,
      request,
      lifetime,
    );
    lifetime.throwIfAborted();
    const result = await read(
      await hostAuthorizationSeams.hostFetch(
        "/api/v1/host-authorizations/verify",
        {
          method: "POST",
          signal: lifetime,
          body: JSON.stringify({
            challenge_id: assertion.challengeId,
            assertion: assertion.value,
          }),
        },
      ),
    );
    lifetime.throwIfAborted();
    if (
      !isJsonObject(result) ||
      result.status !== "authorized" ||
      !isNumber(result.expires_at) ||
      result.expires_at * 1000 <= Date.now()
    )
      throw new HostAuthorizationError();
    if (
      request.operation === "browser.authenticate" &&
      result.elevation === null
    )
      return null;
    if (
      request.operation === "agent.browser.control" &&
      isString(result.elevation) &&
      /^[a-f0-9]{64}$/.test(result.elevation)
    )
      return result.elevation;
    throw new HostAuthorizationError();
  } finally {
    popup.close();
  }
}

function exchange(
  popup: Window,
  origin: string,
  state: string,
  request: HostAuthorizationRequest,
  signal: AbortSignal,
): Promise<{ challengeId: string; value: string }> {
  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    let challengeId: string | null = null;
    let expiresAt = 0;
    const cleanup = () => {
      settled = true;
      clearInterval(closed);
      window.removeEventListener("message", receive);
      signal.removeEventListener("abort", fail);
    };
    const fail = () => {
      cleanup();
      reject(new HostAuthorizationError());
    };
    const start = async () => {
      const challenge = await read(
        await hostAuthorizationSeams.hostFetch("/api/v1/host-authorizations", {
          method: "POST",
          signal,
          body: JSON.stringify(request),
        }),
      );
      signal.throwIfAborted();
      if (settled) throw new HostAuthorizationError();
      if (
        !isJsonObject(challenge) ||
        challenge.origin !== location.origin ||
        challenge.operation !== request.operation ||
        challenge.target_id !== request.target_id ||
        challenge.transition !== request.transition ||
        !isString(challenge.challenge_id) ||
        !isString(challenge.challenge_digest) ||
        !/^[a-f0-9]{64}$/.test(challenge.challenge_digest) ||
        !isNumber(challenge.expires_at) ||
        challenge.expires_at * 1000 <= Date.now() ||
        challenge.expires_at * 1000 > Date.now() + 300000
      )
        throw new HostAuthorizationError();
      challengeId = challenge.challenge_id;
      expiresAt = challenge.expires_at * 1000;
      popup.postMessage(
        { type: "opensesame:host-challenge", state, challenge },
        origin,
      );
    };
    const receive = (event: MessageEvent<BoundaryValue>) => {
      if (settled) return;
      if (
        event.origin !== origin ||
        event.source !== popup ||
        !isJsonObject(event.data) ||
        event.data.state !== state
      )
        return;
      if (
        event.data.type === "opensesame:host-authorization-ready" &&
        !started
      ) {
        started = true;
        void start().catch(fail);
      } else if (event.data.type === "opensesame:host-authorization") {
        const assertion = event.data.assertion;
        if (
          !challengeId ||
          signal.aborted ||
          expiresAt <= Date.now() ||
          !validAssertion(assertion)
        ) {
          fail();
          return;
        }
        cleanup();
        resolve({ challengeId, value: assertion });
      }
    };
    const closed = setInterval(() => {
      if (popup.closed) fail();
    }, 250);
    window.addEventListener("message", receive);
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
  });
}

function validAssertion(value: BoundaryValue | undefined): value is string {
  return isString(value) && value.length > 0 && value.length <= 16000;
}

function validateIdentityUrl(identity: URL) {
  if (
    (identity.protocol !== "https:" && !isLoopbackOrigin(identity.origin)) ||
    identity.username ||
    identity.password ||
    identity.search ||
    identity.hash
  )
    throw new HostAuthorizationError();
}

export function authenticateBrowser(
  signal: AbortSignal,
): Promise<string | null> {
  const grant = currentBrowserGrant(loadSettings().hostApi);
  if (!grant) throw new HostAuthorizationError();
  return authorizeHost(
    {
      operation: "browser.authenticate",
      target_id: grant.clientId,
      transition: null,
    },
    signal,
  );
}
