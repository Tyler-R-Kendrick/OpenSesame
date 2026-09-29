/**
 * MSAL v5 redirect bridge. Must not mount React, run startup SSO, admit an
 * account, create a vault, or call another token-acquisition API.
 *
 * The redirect entry shares @azure/msal-browser with the Entra client, so a
 * selective build evaluates this module from the app shell. Broadcasting is
 * the redirect document's job; on any other document MSAL throws
 * empty_response.
 */
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

const path = globalThis.location?.pathname ?? "";
if (path.endsWith("/auth/redirect.html") || path.endsWith("/auth/redirect")) {
  broadcastResponseToMainFrame();
}
