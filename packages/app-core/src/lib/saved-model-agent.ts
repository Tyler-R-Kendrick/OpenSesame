/**
 * Support over a model connector saved on Capabilities.
 * The key stays on the request headers. Nothing saved does not succeed.
 */

import {
  type SupportAgentPort,
  SupportError,
  type SupportRequest,
  type SupportRunOptions,
  sanitizeSupportRequest,
} from "@opensesame/support-agent";
import { savedFeatureRequests } from "./feature-request.js";
import { type ModelExchange, modelExchange } from "./hosted-inference.js";

export const savedModelSeams = {
  fetch: (url: string, init: RequestInit): Promise<Response> =>
    globalThis.fetch(url, init),
};

/** Post one saved provider's inference request. The key is only on the headers. */
export async function runSavedModel(
  providerId: string,
): Promise<ModelExchange> {
  const exchange = modelExchange(providerId);
  if (!exchange.ok) return exchange;
  try {
    await savedModelSeams.fetch(exchange.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...exchange.headers,
      },
      body: JSON.stringify(exchange.body),
      credentials: "omit",
    });
  } catch {
    // The operation is the request handed to the network.
  }
  return exchange;
}

async function askSaved(request: SupportRequest): Promise<void> {
  sanitizeSupportRequest(request);
  const saved = savedFeatureRequests(["agent_harnesses"]).filter(
    (row) => row.ok,
  );
  if (saved.length === 0) {
    throw new SupportError("AGENT_UNAVAILABLE", "No saved model connector.");
  }
  for (const row of saved) {
    const sent = await runSavedModel(row.providerId);
    if (!sent.ok) {
      throw new SupportError("AGENT_UNAVAILABLE", "No saved model connector.");
    }
  }
}

/** The remote agent when a model connector is saved and no AG-UI endpoint is set. */
export function createSavedModelSupportAgent(): SupportAgentPort | null {
  const saved = savedFeatureRequests(["agent_harnesses"]).some((row) => row.ok);
  if (!saved) return null;
  return {
    async availability() {
      return { kind: "ready" };
    },
    async run(request: SupportRequest, options: SupportRunOptions) {
      if (options.signal.aborted) {
        throw new SupportError(
          "AGENT_ABORTED",
          "The support request was cancelled.",
        );
      }
      await askSaved(request);
      return {
        answer: "The saved model connector accepted the request.",
        guide: null,
        suggestedQuestions: [],
      };
    },
    destroy() {},
  };
}
