/**
 * Mistakes the type checker must keep refusing (ADR 0178).
 *
 * Every `@ts-expect-error` below is a way to delete a webhook endpoint without
 * the ownership check, or with a check about a different endpoint. `tsc` fails
 * the build if one of them starts to compile, so a change to `Named`,
 * `OwnsWebhook` or `deleteWebhookEndpoint` that weakens the guarantee shows up
 * here before it reaches a route. Nothing in this file runs.
 */

import { name } from "@gdp-ts/core";
import type { ControlPlaneRepositories } from "../context.js";
import { actorId, webhookEndpointId } from "../lib/ids.js";
import { deleteWebhookEndpoint } from "../services/webhook-admin.js";
import { ownsWebhook } from "./owns-webhook.js";

export async function ownsWebhookMistakes(
  repos: Pick<ControlPlaneRepositories, "webhookEndpoints">,
): Promise<void> {
  await name(
    actorId("prn_1"),
    webhookEndpointId("whe_a"),
    webhookEndpointId("whe_b"),
    async (actor, endpointA, endpointB) => {
      const verdict = await ownsWebhook(repos, actor, endpointA);
      if (!verdict.ok) return;

      // The honest path compiles: proof about `endpointA`, delete of `endpointA`.
      await deleteWebhookEndpoint(repos, endpointA, verdict.proof);

      // @ts-expect-error — a proof about endpoint A does not authorize deleting B.
      await deleteWebhookEndpoint(repos, endpointB, verdict.proof);

      // @ts-expect-error — no proof at all.
      await deleteWebhookEndpoint(repos, endpointA);

      // @ts-expect-error — a raw id string is not a named endpoint.
      await deleteWebhookEndpoint(repos, "whe_a", verdict.proof);

      // @ts-expect-error — the verdict is not the proof; the refusal case must be handled first.
      await deleteWebhookEndpoint(repos, endpointA, verdict);

      // @ts-expect-error — an actor id is not a webhook endpoint id.
      await ownsWebhook(repos, actor, actor);
    },
  );

  // @ts-expect-error — a name cannot leave the callback it was created in.
  await name(actorId("prn_1"), webhookEndpointId("whe_a"), (_a, e) => e);
}
