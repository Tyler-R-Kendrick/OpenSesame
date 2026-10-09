/** Awaited hosted inference uses one verified native connection and fenced egress. */
import { z } from "zod";
import type { Provider } from "./connections.js";
import {
  type FeatureOperation,
  isListedProvider,
} from "./feature-connector-operation.js";
import {
  type HostedModelOperation,
  type HostedModelTransport,
  hostedModelAuthority,
} from "./hosted-model-authority.js";
import {
  type HostedModelInput,
  type HostedModelResult,
  hostedModelAnswer,
  hostedModelRequest,
  isHostedModelProvider,
} from "./hosted-model-protocol.js";

export type {
  HostedModelInput,
  HostedModelResult,
} from "./hosted-model-protocol.js";
export type HostedModelRuntime = HostedModelTransport & {
  signal: AbortSignal;
};
export type ModelExchange = { ok: false; providerId: string };
/** Compatibility shape only; no credential-bearing delivery logs are collected. */
export type DeliveredModel = { providerId: string; operation: string };
export function deliveredModels(): readonly DeliveredModel[] {
  return [];
}
export function resetDeliveredModels(): void {}
export function modelExchange(provider: Provider | string): ModelExchange {
  return {
    ok: false,
    providerId: isListedProvider(provider) ? provider.id : provider,
  };
}
export function sendModelOperation(operation: FeatureOperation): ModelExchange {
  return { ok: false, providerId: operation.providerId };
}
export function performInference(provider: Provider | string): ModelExchange {
  return modelExchange(provider);
}
function capturedTransport(runtime: HostedModelRuntime): HostedModelTransport {
  return {
    assertCurrent() {
      runtime.signal.throwIfAborted();
      runtime.assertCurrent();
    },
    fetch(url, init) {
      runtime.signal.throwIfAborted();
      const signal = init?.signal
        ? AbortSignal.any([runtime.signal, init.signal])
        : runtime.signal;
      return runtime.fetch(url, { ...init, signal });
    },
  };
}
/** No URL, header, credential, or other saved provider can be selected by the prompt. */
export async function performHostedInference(
  connectionId: string,
  input: HostedModelInput,
  runtime: HostedModelRuntime,
): Promise<HostedModelResult> {
  const transport = capturedTransport(runtime);
  transport.assertCurrent();
  const authority = hostedModelAuthority();
  const connection = authority?.read(connectionId);
  if (
    !connection ||
    connection.status !== "connected" ||
    connection.method !== "api-key"
  )
    throw new Error("Verify the selected model provider connection first");
  const providerId = connection.providerId;
  if (!isHostedModelProvider(providerId))
    throw new Error("This provider has no supported browser model protocol");
  const request = hostedModelRequest(providerId, input);
  const url = new URL(request.url);
  const definition: HostedModelOperation = {
    providerId,
    operationId: "model.inference",
    method: "POST",
    origin: url.origin,
    path: url.pathname,
  };
  if (providerId === "anthropic")
    definition.headers = {
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  if (!authority)
    throw new Error("Enable External connectors to use this model");
  const answer = await authority.execute(
    connectionId,
    definition,
    request.body,
    (body) => hostedModelAnswer(providerId, body),
    { ...transport, signal: runtime.signal },
  );
  transport.assertCurrent();
  return { providerId, model: input.model, answer: z.string().parse(answer) };
}
