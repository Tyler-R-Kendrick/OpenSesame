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

function validateRequest(
  request: AuthRequest,
  maxLifetime = 10 * 60_000,
): void {
  nativeAuthState(request.state);
  const url = new URL(request.authorizationUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    request.expiresAt <= Date.now() ||
    request.expiresAt > Date.now() + maxLifetime
  )
    throw new Error("Invalid or expired provider authorization request");
}

type PopupSession = {
  popup: Window;
  started: boolean;
  cancelled: boolean;
  cancelWait: (() => void) | null;
};
function cancelSession(session: PopupSession): void {
  session.cancelled = true;
  session.cancelWait?.();
  session.popup.close();
}
function startSession(
  session: PopupSession,
  request: AuthRequest,
  maxLifetime = 10 * 60_000,
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
      session.popup.close();
      if (response) resolve(response);
      else reject(new Error("Provider authorization was cancelled or expired"));
    };
    const abort = () => finish();
    const deadline = setTimeout(abort, request.expiresAt - Date.now());
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
    return await waitForCode(session, request, (accept) =>
      listenForCallback(channel, request, redirectUri, accept),
    );
  } catch (error) {
    session.popup.close();
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
    session.popup.close();
    throw error;
  }
}
function showRedirectConsent(
  session: PopupSession,
  request: NativeAuthRedirectConsentRequest,
): NativeOAuthDeviceConsent {
  try {
    startSession(session, request, 30 * 60_000);
    const uri = new URL(request.authorizationUrl);
    if (uri.protocol !== "https:")
      throw new Error("Invalid provider consent request; use HTTPS");
    const lifetime = new AbortController();
    const close = () => {
      clearTimeout(deadline);
      session.popup.close();
    };
    const abort = () => {
      lifetime.abort();
      close();
    };
    const deadline = setTimeout(abort, request.expiresAt - Date.now());
    session.cancelWait = abort;
    session.popup.opener = null;
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
