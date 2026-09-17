/**
 * MSAL v5 redirect bridge. Must not mount React, run startup SSO, admit an
 * account, create a vault, or call another token-acquisition API.
 */
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

broadcastResponseToMainFrame();
