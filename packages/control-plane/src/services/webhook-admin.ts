/**
 * Webhook mutations that demand an `OwnsWebhook` proof about the exact endpoint
 * they touch (ADR 0178). `deleteById` takes a bare id and no principal, so the
 * proof is what stops a delete from reaching an endpoint the caller does not own.
 */

import type { Named } from "@gdp-ts/core";
import type { ControlPlaneRepositories } from "../context.js";
import type { WebhookEndpointId } from "../lib/ids.js";
import type { OwnsWebhook } from "../proofs/owns-webhook.js";

export function deleteWebhookEndpoint<A, W>(
  repos: Pick<ControlPlaneRepositories, "webhookEndpoints">,
  endpoint: Named<W, WebhookEndpointId>,
  _proof: OwnsWebhook<A, W>,
): Promise<boolean> {
  return repos.webhookEndpoints.deleteById(endpoint.value);
}
