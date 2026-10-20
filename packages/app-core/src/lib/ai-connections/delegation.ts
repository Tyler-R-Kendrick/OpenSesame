/** Model-key lending retains the closed catalog contract and reads only the owning vault's verified key. */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { modelApiOf } from "../ai-model-provider.js";
import type {
  HostedModelFence,
  HostedModelOperation,
} from "../hosted-model-authority.js";
import { inspectCall } from "../model-keys/protocols.js";
import { withinSendLimits } from "../model-keys/request-limits.js";
import { NativeApiError, nativeApiHttp } from "../native-api-http.js";
import { assertNativeConnectorRevision } from "../native-connector-store.js";
import { invalidateNativeKey, requireNativeKey } from "../native-key-state.js";
import {
  assertVaultCredentials,
  initializeVaultCredentialCustody,
  readVaultCredentials,
} from "../vault-credential-custody.js";
import {
  aiConnectionBase,
  aiConnectionBinding,
  aiCredentialDigest,
} from "./configuration.js";
import { aiConnectionHeaders } from "./protocol.js";
import { AI_CONNECTION_CLASSIFICATION, readAiConnection } from "./store.js";
import { captureAiConnectionTransport } from "./transport.js";
import { AiConnectionError, isAiSpeechFamily } from "./types.js";
import { aiVaultSeams } from "./vault-guard.js";

function unavailable(): never {
  throw new AiConnectionError(
    "authentication",
    "Configured AI delegation requires a verified vault key and its exact canonical catalog protocol and endpoint.",
  );
}
function delegationState(id: string) {
  const draft = readAiConnection(id);
  if (
    !draft ||
    draft.authentication !== "api-key" ||
    draft.family === "openai_responses" ||
    draft.family === "bedrock_converse" ||
    draft.family === "replicate_predictions" ||
    isAiSpeechFamily(draft.family)
  )
    return unavailable();
  const api = modelApiOf(draft.providerId);
  if (
    !api?.baseUrl ||
    api.protocol !== draft.family ||
    aiConnectionBase(api.baseUrl).href !== aiConnectionBase(draft.baseUrl).href
  )
    return unavailable();
  const record = requireNativeKey(
    {
      family: "AI",
      accepts: (providerId) => providerId === draft.providerId,
      classification: AI_CONNECTION_CLASSIFICATION,
    },
    id,
    true,
  );
  const tomb = record.configuration.parameters.vault_tomb;
  const encoded = record.privateState.credentials.ai_credential_reference;
  if (!tomb || !encoded) return unavailable();
  const capture = readVaultCredentials(
    decodeURIComponent(encoded),
    aiConnectionBinding(draft),
    ["apiKey"],
    tomb,
  );
  const key = capture.fields.get("apiKey");
  if (
    !key ||
    aiCredentialDigest(key) !==
      record.privateState.credentials.ai_credential_digest
  )
    return unavailable();
  draft.apiKey = key;
  return {
    draft,
    record,
    capture,
    tomb,
    baseUrl: aiConnectionBase(api.baseUrl).href.replace(/\/$/, ""),
    protocol: draft.family,
  };
}

/** Admission is deliberately synchronous and fails closed before vault custody is initialized. */
export function aiDelegationAvailable(id: string): boolean {
  try {
    delegationState(id);
    return true;
  } catch {
    return false;
  }
}

function inspectedRequest(
  state: ReturnType<typeof delegationState>,
  definition: HostedModelOperation,
  body: BoundaryValue,
) {
  const base = new URL(state.baseUrl);
  if (
    definition.providerId !== state.draft.providerId ||
    (definition.origin !== undefined && definition.origin !== base.origin)
  )
    return unavailable();
  const prefix = base.pathname === "/" ? "" : base.pathname;
  if (
    !definition.path.startsWith(`${prefix}/`) ||
    /[?#\\\r\n]/.test(definition.path)
  )
    return unavailable();
  if (
    definition.operationId !== "model.inference" &&
    definition.operationId !== "model.list"
  )
    return unavailable();
  const inspected = inspectCall({
    protocol: state.protocol,
    baseUrl: state.baseUrl,
    operation: definition.operationId === "model.list" ? "list" : "invoke",
    method: definition.method,
    path: definition.path.slice(prefix.length),
    body,
  });
  if (inspected.model !== null && inspected.model !== state.draft.model)
    return unavailable();
  return { inspected, headers: delegatedHeaders(state, definition) };
}
function delegatedHeaders(
  state: ReturnType<typeof delegationState>,
  definition: HostedModelOperation,
) {
  const headers = aiConnectionHeaders(state.draft);
  for (const [name, value] of Object.entries(definition.headers ?? {})) {
    if (
      !name.toLowerCase().startsWith("anthropic-") ||
      headers.get(name) !== value
    )
      return unavailable();
  }
  return headers;
}

function secretFree(value: BoundaryValue, secret: string): void {
  try {
    withinSendLimits(overlapCast(value));
  } catch {
    throw new NativeApiError("response");
  }
  const text = JSON.stringify(value);
  if (
    !text ||
    text.includes(secret) ||
    text.includes(JSON.stringify(secret).slice(1, -1))
  )
    throw new NativeApiError("response");
}

/** The broker still owns model/resource grants and budgets; this boundary re-inspects before attaching authority. */
export async function executeAiDelegatedRequest(
  id: string,
  definition: HostedModelOperation,
  body: BoundaryValue,
  project: (body: BoundaryValue) => BoundaryValue,
  fence: HostedModelFence,
): Promise<BoundaryValue> {
  const port = captureAiConnectionTransport();
  const guard = await aiVaultSeams.capture();
  try {
    port.assertCurrent();
    const signal = AbortSignal.any([guard.signal, port.signal, fence.signal]);
    const baseCheck = () => {
      guard.check();
      port.assertCurrent();
      fence.assertCurrent();
      signal.throwIfAborted();
    };
    baseCheck();
    await initializeVaultCredentialCustody();
    baseCheck();
    const state = delegationState(id);
    if (guard.tomb !== state.tomb) return unavailable();
    const check = () => {
      assertVaultCredentials(state.capture, guard.tomb, baseCheck);
      const current = delegationState(id);
      if (
        current.record.revision !== state.record.revision ||
        current.record.configuration.fingerprint !==
          state.record.configuration.fingerprint
      )
        throw new AiConnectionError(
          "stale",
          "This delegated AI connection changed. Configure and authorize it again.",
        );
    };
    check();
    const { inspected, headers } = inspectedRequest(state, definition, body);
    secretFree(inspected.body, state.draft.apiKey);
    const expected = {
      revision: state.record.revision,
      fingerprint: state.record.configuration.fingerprint,
    };
    await assertNativeConnectorRevision(id, expected);
    check();
    const transport = {
      assertCurrent: check,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        check();
        definition.onDispatch?.();
        return port.fetch(inspected.url, init);
      },
    };
    try {
      const request = {
        url: inspected.url,
        method: inspected.method,
        headers,
        signal,
      };
      const reply = await nativeApiHttp(
        inspected.body === null
          ? request
          : { ...request, body: JSON.stringify(inspected.body) },
        transport,
      );
      check();
      await assertNativeConnectorRevision(id, expected);
      check();
      secretFree(reply, state.draft.apiKey);
      let output: BoundaryValue;
      try {
        output = project(reply);
      } catch {
        throw new NativeApiError("response");
      }
      secretFree(output, state.draft.apiKey);
      check();
      return output;
    } catch (error) {
      if (error instanceof NativeApiError && error.code === "authorization") {
        check();
        await invalidateNativeKey(
          AI_CONNECTION_CLASSIFICATION,
          state.record,
          transport,
        );
      }
      throw error;
    }
  } finally {
    guard.close();
  }
}
