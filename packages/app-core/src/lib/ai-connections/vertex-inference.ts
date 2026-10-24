/** Finite Vertex inference; no streaming progress is claimed for a buffered carrier. */
import { aiCompletionSeams } from "../ai-completion-observation.js";
import {
  type HostedModelInput,
  hostedModelAnswer,
  hostedModelRequest,
} from "../hosted-model-protocol.js";
import type { NativeProviderTransport } from "../native-connector-transport.js";
import { gcpAccessToken, parseGcpServiceAccount } from "../native-gcp-auth.js";
import { aiConnectionBase } from "./configuration.js";
import { checkAiResponse, readAiJson } from "./http.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";
import {
  type VertexAiDraft,
  vertexConnectionTarget,
  vertexInferenceUrl,
} from "./vertex-target.js";
function owner(transport: AiConnectionTransport, check: () => void) {
  return () => {
    check();
    transport.assertCurrent();
    transport.signal.throwIfAborted();
  };
}
async function credential(
  draft: VertexAiDraft,
  transport: AiConnectionTransport,
  check: () => void,
) {
  const target = vertexConnectionTarget(draft);
  if (!target)
    throw new AiConnectionError("configuration", "Choose a Vertex target.");
  check();
  if (target.credential === "access-token") {
    if (!/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(draft.apiKey))
      throw new AiConnectionError(
        "authentication",
        "Enter a valid Google access token.",
      );
    return { value: draft.apiKey, privateMaterial: [draft.apiKey] };
  }
  const account = parseGcpServiceAccount(draft.apiKey);
  const captured: NativeProviderTransport = {
    signal: transport.signal,
    assertCurrent: check,
    fetch: (input, init) => {
      check();
      return transport.fetch(String(input), {
        ...init,
        signal: AbortSignal.any([
          transport.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    },
  };
  const value = await gcpAccessToken(account, captured);
  check();
  return { value, privateMaterial: [value, account.privateKey, draft.apiKey] };
}
export async function inferVertexAi(
  draft: VertexAiDraft,
  input: HostedModelInput,
  transport: AiConnectionTransport,
  check: () => void,
  onText?: (text: string) => void,
) {
  const current = owner(transport, check);
  current();
  if (input.model !== draft.model)
    throw new AiConnectionError(
      "configuration",
      "Use the model saved with this connection.",
    );
  const request = hostedModelRequest("gemini", input);
  const base = aiConnectionBase(draft.baseUrl);
  const url = vertexInferenceUrl(draft, base);
  const key = await credential(draft, transport, current);
  current();
  const signal = AbortSignal.any([
    transport.signal,
    AbortSignal.timeout(30_000),
  ]);
  let response: Response;
  try {
    response = await transport.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.value}`,
      },
      body: JSON.stringify(request.body),
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    current();
    throw new AiConnectionError(
      "network",
      "Could not complete this Vertex request.",
    );
  }
  try {
    current();
    checkAiResponse(response);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  aiCompletionSeams.observe?.({
    phase: "request",
    response,
    owner: check,
    httpSignal: signal,
    transportSignal: transport.signal,
  });
  const value = await readAiJson(response, current);
  current();
  const answer = hostedModelAnswer("gemini", value);
  if (
    key.privateMaterial.some(
      (secret) => secret.length >= 4 && answer.includes(secret),
    )
  )
    throw new AiConnectionError(
      "response",
      "The AI service returned credential material.",
    );
  current();
  onText?.(answer);
  current();
  return { providerId: draft.providerId, model: draft.model, answer };
}
