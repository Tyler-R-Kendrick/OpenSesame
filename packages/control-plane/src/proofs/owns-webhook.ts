/**
 * `OwnsWebhook<A, W>` — the webhook endpoint named `W` is registered for the
 * actor named `A` (ADR 0178).
 *
 * The route used to read the endpoint, compare its `principalId`, and then call
 * `deleteById(id)` with a bare id, so the comparison and the delete were two
 * unrelated statements. An endpoint that is someone else's answers `404`, never
 * `403`, so the id space stays unenumerable (ADR 0046); the verdict carries no
 * reason a route could be tempted to turn into a different answer.
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import type { WebhookEndpoint } from "@opensesame/os-domain";
import type { ControlPlaneRepositories } from "../context.js";
import type { ActorId, WebhookEndpointId } from "../lib/ids.js";

const OwnsWebhook = defineProof("OwnsWebhook");
export interface OwnsWebhook<A, W> extends Proof<"OwnsWebhook", [A, W]> {}

export type OwnsWebhookVerdict<A, W> =
  | {
      readonly ok: true;
      readonly proof: OwnsWebhook<A, W>;
      readonly endpoint: WebhookEndpoint;
    }
  | { readonly ok: false };

export async function ownsWebhook<A, W>(
  repos: Pick<ControlPlaneRepositories, "webhookEndpoints">,
  actor: Named<A, ActorId>,
  endpoint: Named<W, WebhookEndpointId>,
): Promise<OwnsWebhookVerdict<A, W>> {
  const found = await repos.webhookEndpoints.getById(endpoint.value);
  if (!found || found.principalId !== actor.value) return { ok: false };
  return {
    ok: true,
    proof: OwnsWebhook.prove(actor, endpoint),
    endpoint: found,
  };
}
