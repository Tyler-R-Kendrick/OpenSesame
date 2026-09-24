/**
 * Browser vault backup writer via the Connect relay.
 *
 * The SPA cannot call api.github.com (no CORS). It posts App credentials once;
 * this relay mints an attenuated installation token, upserts ciphertext, and
 * drops the token. Webhook deliveries enqueue a sync nudge the SPA drains.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { githubAppCorsHeaders, mintGithubAppJwt } from "./github-app.mjs";
import {
  clearWebhookQueue,
  drainWebhookNudges,
  enqueueWebhookNudge,
} from "./webhook-queue.mjs";

export const API = "https://api.github.com";
export const API_VERSION = "2022-11-28";
export const UA = "OpenSesame-ConnectRelay/1";
export const BACKUP_PATH = "opensesame-vault.backup.json";

export function json(status, body, extraHeaders = {}) {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function readCredentials(body) {
  const appId =
    body && (typeof body.appId === "string" || typeof body.appId === "number")
      ? String(body.appId).trim()
      : "";
  const pem = body && typeof body.pem === "string" ? body.pem.trim() : "";
  const installationId =
    body &&
    (typeof body.installationId === "string" ||
      typeof body.installationId === "number")
      ? String(body.installationId).trim()
      : "";
  if (!appId || !pem || !/^\d+$/.test(installationId)) {
    return null;
  }
  return { appId, pem, installationId };
}

export async function mintInstallationToken(
  { appId, pem, installationId, owner, repo },
  fetchImpl,
) {
  const jwt = mintGithubAppJwt(appId, pem);
  const response = await fetchImpl(
    `${API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: "write", metadata: "read" },
      }),
    },
  );
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("installation_token_malformed");
  }
  if (!response.ok || typeof payload.token !== "string") {
    const err = new Error(
      typeof payload.message === "string"
        ? payload.message
        : "installation_token_failed",
    );
    err.status = response.status;
    throw err;
  }
  return payload.token;
}

/**
 * Upsert sealed vault ciphertext. Body:
 * `{ appId, pem, installationId, owner, repo, branch?, contentBase64, message? }`.
 */
