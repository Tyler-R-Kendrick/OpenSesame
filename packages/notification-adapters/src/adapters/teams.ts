/**
 * Microsoft Teams — notify and rendezvous, and nothing else.
 *
 * Outgoing is honest: an incoming webhook posts a card into a channel, and
 * the card carries an `OpenUri` action that sends the person to the
 * OpenSesame ceremony. Inbound is the problem. Accepting a decision from
 * Teams would need a Bot Framework channel with a publicly reachable
 * messaging endpoint and an Entra app registration whose token validation
 * this repository cannot exercise; an `Action.Http` button on a card is an
 * unauthenticated POST that anyone who has seen the card's target URL can
 * make. Treating that as a human decision is the confused-deputy bug this
 * whole design exists to avoid.
 *
 * So the refusal is structural rather than conditional: this adapter has no
 * `verifyCallback` property at all. There is no flag to flip, no branch to
 * mis-read, and `capabilities().canRenderDecisionActions` is `false` in the
 * os-domain catalogue, so `normalizeApprovalPolicy` strips Teams out of
 * `directApprovalChannels` even if an operator writes it there.
 *
 * The card is deliberately dull: a title, the body the templates produced,
 * and one link. No buttons that do anything but navigate.
 */

import {
  type ChannelCapabilities,
  type JsonObject,
  channelCapabilities,
} from "@opensesame/os-domain";

import type {
  ChannelAdapter,
  DeliveryDestination,
  DeliveryOutcome,
  FetchLike,
  RenderInput,
  RenderedMessage,
} from "../contract.js";
import {
  classifyThrown,
  deliveryAbortSignal,
  httpOutcome,
  isHttpsUrl,
} from "../http.js";
import { renderNotification } from "../templates.js";

export const TEAMS_PROVIDER_ID = "teams";

export interface TeamsConfig {
  /**
   * The operator's incoming-webhook URL. It is a bearer capability: whoever
   * holds it can post into that channel as this connector, which is why a
   * non-HTTPS one is refused rather than downgraded, and why it is never
   * echoed into a delivery error.
   */
  webhookUrl?: string;
  fetchImpl?: FetchLike;
}

export function createTeamsAdapter(config: TeamsConfig): ChannelAdapter {
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;

  const isConfigured = (): boolean => isHttpsUrl(config.webhookUrl);

  const capabilities = (): ChannelCapabilities => channelCapabilities("teams");

  const render = (input: RenderInput): RenderedMessage =>
    renderNotification(input, {
      dialect: "teams_markdown",
      channelCeiling: capabilities().confidentiality,
    });

  const deliver = async (
    msg: RenderedMessage,
    dest: DeliveryDestination,
  ): Promise<DeliveryOutcome> => {
    if (dest.channel !== "teams") {
      return { status: "permanent", error: "destination_mismatch" };
    }
    const url = dest.incomingWebhookUrl ?? config.webhookUrl;
    // Checked again for the per-destination override: a binding row is
    // storage, and storage is not a trust boundary.
    if (!isHttpsUrl(url) || !url) {
      return { status: "unconfigured", error: "no_webhook_url" };
    }
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildCard(msg)),
        signal: deliveryAbortSignal(),
      });
      return httpOutcome(response.status);
    } catch (err) {
      return classifyThrown(err instanceof Error ? err : undefined);
    }
  };

  // No `verifyCallback`, and no `update`: an incoming webhook returns no
  // handle to revise, so claiming otherwise would be a capability we cannot
  // honour.
  return { kind: "teams", isConfigured, capabilities, render, deliver };
}

/**
 * A MessageCard with a single `OpenUri` action.
 *
 * `OpenUri` navigates; `HttpPOST` and `ActionCard` would submit. The
 * distinction is the entire security posture of this adapter, so the card is
 * built here in one place rather than assembled from caller-supplied parts.
 */
function buildCard(msg: RenderedMessage): JsonObject {
  const card: JsonObject = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    summary: msg.title,
    themeColor: "0B6BCB",
    title: msg.title,
    text: msg.body,
  };
  if (!msg.rendezvousUrl) return card;
  return {
    ...card,
    potentialAction: [
      {
        "@type": "OpenUri",
        name: "Review in OpenSesame",
        targets: [{ os: "default", uri: msg.rendezvousUrl }],
      },
    ],
  };
}
