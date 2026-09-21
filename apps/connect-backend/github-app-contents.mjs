/**
 * Browser vault backup writer via the Connect relay — re-exports handlers.
 */
export { handleGithubAppPutContents } from "./github-app-put-contents.mjs";
export { handleGithubAppWebhook } from "./github-app-webhook.mjs";

import { json, readCredentials } from "./github-app-contents-shared.mjs";
import { githubAppCorsHeaders, mintGithubAppJwt } from "./github-app.mjs";
import { clearWebhookQueue, drainWebhookNudges } from "./webhook-queue.mjs";

export async function handleGithubAppWebhookPending(body, origin) {
  const cors = githubAppCorsHeaders(origin);
  if (!origin || !cors["access-control-allow-origin"]) {
    return json(403, { error: "origin_not_allowed" });
  }
  const creds = readCredentials(body);
  if (!creds) {
    return json(400, { error: "credentials_required" }, cors);
  }
  try {
    mintGithubAppJwt(creds.appId, creds.pem);
  } catch {
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
