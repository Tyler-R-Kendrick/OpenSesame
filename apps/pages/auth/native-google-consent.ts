import { readNativeGoogleRequest } from "@opensesame/app-core/browser/native-google-request.js";
import {
  type GoogleIdentitySdk,
  loadNativeGoogleSdk,
  requestNativeGoogleSdkConsent,
  revokeNativeGoogleSdkToken,
} from "@opensesame/app-core/browser/native-google-sdk.js";
import { deliverNativeImplicitPayload } from "@opensesame/app-core/browser/native-implicit-session.js";
/** Public consent page: a fresh click opens GIS; bearer returns only encrypted. */
import type { IssuedNativeOAuthToken } from "@opensesame/app-core/lib/native-browser-oauth-token.js";

const fragment = window.location.hash;
window.history.replaceState(null, "", window.location.pathname);
const redirectUri = new URL(window.location.pathname, window.location.origin)
  .href;
const status = document.getElementById("status");
const authorize = document.getElementById("authorize");
const cancel = document.getElementById("cancel");
if (
  !(status instanceof HTMLElement) ||
  !(authorize instanceof HTMLButtonElement) ||
  !(cancel instanceof HTMLButtonElement)
)
  throw new Error("Google consent controls are unavailable");
const lifetime = new AbortController();
async function start(): Promise<void> {
  const request = readNativeGoogleRequest(fragment, Date.now());
  const timeout = setTimeout(() => {
    lifetime.abort();
    authorize.disabled = true;
    status.textContent =
      "Google sign-in expired. Return to your connection and try again.";
  }, request.expiresAt - Date.now());
  const deliver = (
    payload: Parameters<typeof deliverNativeImplicitPayload>[3],
  ) =>
    deliverNativeImplicitPayload(request.state, "google", redirectUri, payload);
  cancel.onclick = () => {
    lifetime.abort();
    authorize.disabled = true;
    status.textContent = "Cancelling Google sign-in…";
    void deliver({ error: true })
      .then(
        () => window.close(),
        () => {
          status.textContent = "Google sign-in cancelled.";
        },
      )
      .finally(() => clearTimeout(timeout));
  };
  const sdk = await loadNativeGoogleSdk(lifetime.signal);
  status.textContent = "Authorize your selected permissions with Google.";
  authorize.disabled = false;
  authorize.onclick = () => {
    authorize.disabled = true;
    status.textContent = "Waiting for Google authorization…";
    requestNativeGoogleSdkConsent(
      sdk,
      request,
      (token) => void receive(sdk, token),
      (error) => {
        status.textContent = error.message;
        if (error.code === "denied")
          void deliver({ error: true })
            .then(
              () => window.close(),
              () => undefined,
            )
            .finally(() => clearTimeout(timeout));
      },
    );
  };
  async function revoke(accessToken: string): Promise<void> {
    try {
      await revokeNativeGoogleSdkToken(sdk, accessToken);
      status.textContent =
        "Google sign-in could not complete. Authorization was revoked; please try again.";
    } catch {
      status.textContent =
        "Google sign-in could not complete. Remove this app from your Google account permissions before trying again.";
    }
  }
  async function receive(
    sdk: GoogleIdentitySdk,
    token: IssuedNativeOAuthToken,
  ): Promise<void> {
    if (lifetime.signal.aborted) {
      await revoke(token.accessToken);
      return;
    }
    try {
      await deliver({
        accessToken: token.accessToken,
        tokenType: "Bearer",
        expiresIn:
          token.expiresAt === null
            ? null
            : Math.max(0, (token.expiresAt - Date.now()) / 1000),
        scopes: token.scopes,
        protocolValid: token.protocolValid,
      });
      clearTimeout(timeout);
      status.textContent = "Google connected. Returning to your connection…";
      window.close();
    } catch {
      clearTimeout(timeout);
      await revoke(token.accessToken);
    }
  }
}
void start().catch(() => {
  authorize.disabled = true;
  status.textContent =
    "Google sign-in is unavailable or expired. Return to your connection and try again.";
});
