/**
 * Browser vault backup writer via the Connect relay — re-exports handlers.
 */
export { handleGithubAppPutContents } from "./github-app-put-contents.mjs";
export { handleGithubAppWebhook } from "./github-app-webhook.mjs";

import {
  API,
  API_VERSION,
  UA,
  json,
  readCredentials,
} from "./github-app-contents-shared.mjs";
import { githubAppCorsHeaders, mintGithubAppJwt } from "./github-app.mjs";
import { clearWebhookQueue, drainWebhookNudges } from "./webhook-queue.mjs";

/**
 * True only when GitHub itself says `installationId` belongs to the App the
 * presented key signs for. A PEM that merely parses proves nothing: any RSA
 * key mints a well-formed JWT, and draining is destructive.
 */
async function installationOwned(creds, fetchImpl) {
  const jwt = mintGithubAppJwt(creds.appId, creds.pem);
  const response = await fetchImpl(
    `${API}/app/installations/${encodeURIComponent(creds.installationId)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": UA,
      },
      redirect: "error",
    },
  );
  if (response.status !== 200) return false;
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    return false;
  }
  return (
    payload !== null &&
    typeof payload === "object" &&
    String(payload.id) === creds.installationId &&
    String(payload.app_id) === creds.appId
  );
}

export async function handleGithubAppWebhookPending(
  body,
  origin,
  fetchImpl = fetch,
) {
  const cors = githubAppCorsHeaders(origin);
  if (!origin || !cors["access-control-allow-origin"]) {
    return json(403, { error: "origin_not_allowed" });
  }
  const creds = readCredentials(body);
  if (!creds) {
    return json(400, { error: "credentials_required" }, cors);
  }
  let owned = false;
  try {
    owned = await installationOwned(creds, fetchImpl);
  } catch {
    owned = false;
  }
  if (!owned) {
    return json(401, { error: "credentials_invalid" }, cors);
  }
  let events;
  try {
    events = await drainWebhookNudges(creds.installationId);
  } catch {
    return json(503, { error: "queue_unavailable" }, cors);
  }
  return json(200, { events }, cors);
}

/** Test helper — drop queued webhook nudges. */
export function clearGithubAppWebhookPending() {
  clearWebhookQueue();
}
