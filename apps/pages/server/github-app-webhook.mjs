import { createHmac, timingSafeEqual } from "node:crypto";
import { enqueueWebhookNudge } from "./webhook-queue.mjs";

function plain(status, body) {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body,
  };
}

function readHeader(headers, lower, mixed) {
  if (typeof headers[lower] === "string") return headers[lower];
  if (typeof headers[mixed] === "string") return headers[mixed];
  return "";
}

function verifyGithubWebhookSignature(secret, signature, rawBody) {
  if (!signature.startsWith("sha256=")) {
    return plain(401, "signature_required");
  }
  if (typeof rawBody !== "string" || rawBody.length === 0) {
    return plain(401, "raw_body_required");
  }
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(`sha256=${digest}`, "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return plain(401, "signature_invalid");
  }
  return null;
}

export async function handleGithubAppWebhook(body, headers = {}, rawBody = "") {
  const secret =
    typeof process !== "undefined" && process.env.GITHUB_WEBHOOK_SECRET
      ? String(process.env.GITHUB_WEBHOOK_SECRET).trim()
      : "";
  if (!secret) return plain(503, "webhook_secret_unset");
  const signature = readHeader(
    headers,
    "x-hub-signature-256",
    "X-Hub-Signature-256",
  );
  const invalid = verifyGithubWebhookSignature(secret, signature, rawBody);
  if (invalid) return invalid;
  const delivery =
    readHeader(headers, "x-github-delivery", "X-GitHub-Delivery") ||
    `evt_${Date.now()}`;
  const installation =
    body?.installation &&
    typeof body.installation === "object" &&
    body.installation.id != null
      ? String(body.installation.id)
      : null;
  try {
    await enqueueWebhookNudge({
      id: delivery,
      installationId: installation,
      receivedAt: new Date().toISOString(),
    });
  } catch {
    return plain(503, "queue_unavailable");
  }
  return plain(204, "");
}
