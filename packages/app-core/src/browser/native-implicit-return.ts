/** Capture and scrub an approved implicit return before any asynchronous work. */
import {
  type NativeImplicitPayload,
  parseNativeImplicitState,
} from "./native-implicit-crypto.js";
import { deliverNativeImplicitPayload } from "./native-implicit-session.js";
function unique(fragment: URLSearchParams, name: string): string | null {
  if (fragment.getAll(name).length > 1)
    throw new Error("Ambiguous provider return");
  return fragment.get(name);
}
function expiration(fragment: URLSearchParams): number | null {
  const expiration = unique(fragment, "expires_in");
  const seconds =
    expiration && /^\d+$/.test(expiration) ? Number(expiration) : null;
  return seconds && Number.isFinite(seconds) && seconds <= 365 * 86400
    ? seconds
    : null;
}
function grantedScopes(fragment: URLSearchParams): string[] | null {
  const scope = unique(fragment, "scope");
  const parts = scope === null ? null : scope.split(/\s+/).filter(Boolean);
  return parts &&
    parts.length <= 256 &&
    parts.every((value) => value.length <= 512)
    ? parts
    : null;
}
export type NativeImplicitReturn = {
  state: string;
  providerId: "discord" | "reddit";
  payload: NativeImplicitPayload;
};
export function captureNativeImplicitReturn(url: URL): NativeImplicitReturn {
  if (url.hash.length > 262144 || url.search)
    throw new Error("Invalid provider return");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const state = unique(fragment, "state") ?? "";
  const body = parseNativeImplicitState(state);
  if (body.p === "google")
    throw new Error("Google uses its approved browser SDK");
  const accessToken = unique(fragment, "access_token");
  const denied = unique(fragment, "error");
  if (!accessToken) {
    if (!denied) throw new Error("Provider did not return a credential");
    return { state, providerId: body.p, payload: { error: true } };
  }
  if (!/^[!-~]{1,32768}$/.test(accessToken))
    throw new Error("Invalid provider credential");
  const tokenType = unique(fragment, "token_type") ?? "";
  const expiresIn = expiration(fragment);
  const scopes = grantedScopes(fragment);
  return {
    state,
    providerId: body.p,
    payload: {
      accessToken,
      tokenType: tokenType.slice(0, 256),
      expiresIn,
      scopes,
      protocolValid:
        !denied &&
        tokenType.toLowerCase() === "bearer" &&
        expiresIn !== null &&
        scopes !== null,
    },
  };
}
export async function runNativeImplicitReturn(): Promise<void> {
  const url = new URL(window.location.href);
  window.history.replaceState(null, "", url.pathname);
  const captured = captureNativeImplicitReturn(url);
  url.hash = "";
  url.search = "";
  await deliverNativeImplicitPayload(
    captured.state,
    captured.providerId,
    url.href,
    captured.payload,
  );
  const status = document.querySelector("p");
  if (status)
    status.textContent = "Connection returned. You can close this window.";
  window.close();
}
