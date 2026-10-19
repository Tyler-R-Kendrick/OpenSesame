import type {
  NativeOAuthDeviceConsent,
  NativeOAuthDeviceConsentRequest,
} from "../lib/native-oauth-browser-port.js";
import {
  type NativeAuthBroadcast,
  type NativeAuthCode,
  type NativeAuthWireCode,
  nativeAuthCallbackUrl,
  nativeAuthChannel,
  nativeAuthState,
  parseNativeAuthBroadcast,
  parseNativeAuthCode,
} from "./native-auth-message.js";

type AuthRequest = {
  authorizationUrl: string;
  state: string;
  expiresAt: number;
  signal?: AbortSignal;
};
export type NativeAuthReturnRequest = AuthRequest & { redirectUri: string };
export type NativeAuthWebMessageRequest = AuthRequest & {
  expectedOrigin: string;
  parse?: (data: NativeAuthWireCode) => NativeAuthCode | null;
};
export type NativeAuthRedirectConsentRequest = Pick<
  AuthRequest,
  "authorizationUrl" | "state" | "expiresAt"
>;
export type NativeAuthPopup = {
  wait: (request: NativeAuthReturnRequest) => Promise<NativeAuthCode>;
  waitWebMessage: (
    request: NativeAuthWebMessageRequest,
  ) => Promise<NativeAuthCode>;
  showDeviceConsent: (
    request: NativeOAuthDeviceConsentRequest,
  ) => NativeOAuthDeviceConsent;
  showRedirectConsent: (
    request: NativeAuthRedirectConsentRequest,
  ) => NativeOAuthDeviceConsent;
  cancel: () => void;
};

/** The longest a consent window waits: a code return, and a redirect consent. */
const CONSENT_LIFETIME_MS = 10 * 60_000;
const REDIRECT_CONSENT_LIFETIME_MS = 30 * 60_000;
/**
 * How far the wall clock may step back between minting a request and opening
 * its window. `Date.now()` is not monotonic (a clock correction, an emulated
 * clock), and a caller that mints the whole lifetime (`createdAt + 10 min`)
 * would otherwise be refused here, closing the window it reserved unused.
 * Every wait below is still capped at the lifetime, so this lengthens nothing.
 */
const CLOCK_STEP_BACK_MS = 30_000;

function validateRequest(
  request: AuthRequest,
  maxLifetime = CONSENT_LIFETIME_MS,
): void {
  nativeAuthState(request.state);
  let url: URL;
  try {
    url = new URL(request.authorizationUrl);
  } catch {
    throw new Error("Invalid provider authorization URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid provider authorization URL");
  const remaining = request.expiresAt - Date.now();
  if (remaining <= 0)
    throw new Error("Provider authorization request expired");
  if (remaining > maxLifetime + CLOCK_STEP_BACK_MS)
    throw new Error("Provider authorization request exceeds allowed lifetime");
}
/** How long the window may still wait, never past the profile's lifetime. */
function remainingLifetime(request: AuthRequest, maxLifetime: number): number {
  return Math.min(request.expiresAt - Date.now(), maxLifetime);
}

type PopupSession = {
  popup: Window;
  isolated: boolean;
  started: boolean;
  cancelled: boolean;
  cancelWait: (() => void) | null;
};
function closeSessionPopup(session: PopupSession): void {
  if (session.isolated) {
    // Nulling the opener removes our right to close a foreign consent window.
    // Reading its location succeeds again once the callback returns to us.
    try {
      const href = session.popup.location.href;
      if (
        href !== "about:blank" &&
        new URL(href).origin !== window.location.origin
      )
        return;
    } catch {
      return;
    }
  }
  session.popup.close();
}
function cancelSession(session: PopupSession): void {
  session.cancelled = true;
  session.cancelWait?.();
  closeSessionPopup(session);
}
function startSession(
  session: PopupSession,
  request: AuthRequest,
  maxLifetime = CONSENT_LIFETIME_MS,
): void {
  if (session.started || session.cancelled)
    throw new Error("This provider authorization window was already used");
  session.started = true;
  validateRequest(request, maxLifetime);
  if (request.signal?.aborted)
    throw new Error("Provider authorization was cancelled");
}
function waitForCode(
  session: PopupSession,
  request: AuthRequest,
  listen: (accept: (code: NativeAuthCode) => void) => () => void,
): Promise<NativeAuthCode> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopListening: () => void = () => undefined;
    const finish = (response?: NativeAuthCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      stopListening();
      request.signal?.removeEventListener("abort", abort);
      session.cancelWait = null;
      closeSessionPopup(session);
      if (response) resolve(response);
      else reject(new Error("Provider authorization was cancelled or expired"));
    };
    const abort = () => finish();
    const deadline = setTimeout(
      abort,
      remainingLifetime(request, CONSENT_LIFETIME_MS),
    );
    session.cancelWait = abort;
    request.signal?.addEventListener("abort", abort, { once: true });
    stopListening = listen((response) => {
      if (response.state === request.state && Date.now() < request.expiresAt)
        finish(response);
    });
    // COOP can sever the WindowProxy on provider navigation. Never interpret
    // popup.closed as cancellation: the real callback still reaches our channel.
    try {
      session.popup.location.replace(request.authorizationUrl);
    } catch {
      finish();
    }
  });
}
function listenForCallback(
  channel: BroadcastChannel,
  request: NativeAuthReturnRequest,
  redirectUri: string,
  accept: (code: NativeAuthCode) => void,
): () => void {
  channel.onmessage = (event: MessageEvent<NativeAuthBroadcast>) => {
    const data = parseNativeAuthBroadcast(event.data);
    if (!data || data.redirectUri !== redirectUri) return;
    const response = parseNativeAuthCode(data);
    if (
      !response ||
      response.state !== request.state ||
      Date.now() >= request.expiresAt
    )
      return;
    channel.postMessage({ kind: "accepted", receipt: data.receipt });
    accept(response);
  };
  return () => channel.close();
}
async function waitForCallback(
  session: PopupSession,
  request: NativeAuthReturnRequest,
): Promise<NativeAuthCode> {
  try {
    startSession(session, request);
    const redirectUri = nativeAuthCallbackUrl(request.redirectUri);
    if (!globalThis.BroadcastChannel)
      throw new Error("This browser cannot return provider authorization");
    const channel = new BroadcastChannel(
      await nativeAuthChannel(request.state),
    );
    if (session.cancelled || request.signal?.aborted) {
      channel.close();
      throw new Error("Provider authorization was cancelled");
    }
    // Static callbacks need no provider access to the initiating window.
    session.popup.opener = null;
    session.isolated = true;
    return await waitForCode(session, request, (accept) =>
      listenForCallback(channel, request, redirectUri, accept),
    );
  } catch (error) {
    closeSessionPopup(session);
    throw error;
  }
}
async function waitForWebMessage(
  session: PopupSession,
  request: NativeAuthWebMessageRequest,
): Promise<NativeAuthCode> {
  try {
    startSession(session, request);
    const origin = new URL(request.expectedOrigin);
    if (origin.href !== `${origin.origin}/` || origin.protocol !== "https:")
      throw new Error("Use the exact provider message origin");
    if (globalThis.crossOriginIsolated)
      throw new Error("Use the static callback with browser isolation");
    return await waitForCode(session, request, (accept) => {
      const receive = (event: MessageEvent<NativeAuthWireCode>) => {
        if (event.origin !== origin.origin || event.source !== session.popup)
          return;
        const response = (request.parse ?? parseNativeAuthCode)(event.data);
        if (response) accept(response);
      };
      window.addEventListener("message", receive);
      return () => window.removeEventListener("message", receive);
    });
  } catch (error) {
    closeSessionPopup(session);
    throw error;
  }
}
function showRedirectConsent(
  session: PopupSession,
  request: NativeAuthRedirectConsentRequest,
): NativeOAuthDeviceConsent {
  try {
    startSession(session, request, REDIRECT_CONSENT_LIFETIME_MS);
    const uri = new URL(request.authorizationUrl);
    if (uri.protocol !== "https:")
      throw new Error("Invalid provider consent request; use HTTPS");
    const lifetime = new AbortController();
    const close = () => {
      clearTimeout(deadline);
      closeSessionPopup(session);
    };
    const abort = () => {
      lifetime.abort();
      close();
    };
    const deadline = setTimeout(
      abort,
      remainingLifetime(request, REDIRECT_CONSENT_LIFETIME_MS),
    );
    session.cancelWait = abort;
    session.popup.opener = null;
    session.isolated = true;
    session.popup.location.replace(uri.href);
    return { signal: lifetime.signal, close };
  } catch (error) {
    cancelSession(session);
    throw error;
  }
}
function showDeviceConsent(
  session: PopupSession,
  request: NativeOAuthDeviceConsentRequest,
): NativeOAuthDeviceConsent {
  try {
    const uri = new URL(request.verificationUri);
    if (
      uri.protocol !== "https:" ||
      uri.hash ||
      !/^[!-~]{1,256}$/.test(request.userCode)
    )
      throw new Error("Invalid provider device authorization request");
    return showRedirectConsent(session, {
      authorizationUrl: request.verificationUri,
      state: request.state,
      expiresAt: request.expiresAt,
    });
  } catch (error) {
    cancelSession(session);
    throw error;
  }
}
/** Reserve during the click, before discovery/auth_url network requests await. */
export function reserveNativeAuthPopup(): NativeAuthPopup {
  const popup = window.open(
    "about:blank",
    "_blank",
    "popup,width=600,height=720",
  );
  if (!popup)
    throw new Error("Allow the provider sign-in window and try again");
  const session: PopupSession = {
    popup,
    isolated: false,
    started: false,
    cancelled: false,
    cancelWait: null,
  };
  return {
    cancel: () => cancelSession(session),
    wait: (request) => waitForCallback(session, request),
    waitWebMessage: (request) => waitForWebMessage(session, request),
    showDeviceConsent: (request) => showDeviceConsent(session, request),
    showRedirectConsent: (request) => showRedirectConsent(session, request),
  };
}
