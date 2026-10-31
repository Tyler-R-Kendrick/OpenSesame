import type { BoundaryValue } from "@opensesame/os-domain";
import { aiCompletionSeams } from "../ai-completion-observation.js";
import {
  nativeResponseBodySignal as aiResponseBodySignal,
  bindNativeResponseLifetime,
  finishNativeResponseBody as finishAiResponseBody,
  hasNativeResponseLifetime,
} from "../native-response-lifetime.js";
import { aiConnectionBase } from "./configuration.js";
import { aiConnectionHeaders, type aiInferenceRequest } from "./protocol.js";
import { aiStreamBody } from "./stream-body.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiConnectionTransport,
} from "./types.js";

export function bindAiResponseLifetime(
  response: Response,
  retire: () => void,
  signal: AbortSignal,
) {
  if (hasNativeResponseLifetime(response))
    throw new AiConnectionError(
      "response",
      "The AI transport reused a live response.",
    );
  bindNativeResponseLifetime(response, retire, signal);
}

/** Keep existing AI consumers on the single neutral physical-response registry. */
export { aiResponseBodySignal, finishAiResponseBody };

export {
  type AiCompletionObservation,
  aiCompletionSeams,
} from "../ai-completion-observation.js";

/** Finite operations retain the original transport identity and owning caller. */
export function aiFiniteProtocolAuthority(
  transport: AiConnectionTransport,
  owner: () => void,
) {
  const { signal, assertCurrent, fetch } = transport;
  const check = () => {
    signal.throwIfAborted();
    if (
      transport.signal !== signal ||
      transport.assertCurrent !== assertCurrent ||
      transport.fetch !== fetch
    )
      throw new AiConnectionError(
        "stale",
        "The transcription transport changed.",
      );
    owner();
    assertCurrent.call(transport);
    signal.throwIfAborted();
    if (
      transport.signal !== signal ||
      transport.assertCurrent !== assertCurrent ||
      transport.fetch !== fetch
    )
      throw new AiConnectionError(
        "stale",
        "The transcription transport changed.",
      );
  };
  check();
  return check;
}
export function checkAiResponse(response: Response): void {
  if (response.status === 401 || response.status === 403)
    throw new AiConnectionError(
      "authentication",
      "The AI service refused the credential or its permissions.",
    );
  if (!response.ok || response.redirected)
    throw new AiConnectionError(
      "response",
      `The AI service request failed (HTTP ${response.status}).`,
    );
}

/** The request URL is built from saved configuration, never from the prompt. */
export async function aiConnectionFetch(
  draft: AiConnectionDraft,
  url: URL,
  transport: AiConnectionTransport,
  check: () => void,
  body?: ReturnType<typeof aiInferenceRequest>["body"],
): Promise<Response> {
  assertAiRequest(draft, url, transport, check);
  const request: AiProtocolRequest = {
    method: body === undefined ? "GET" : "POST",
    headers: aiConnectionHeaders(draft),
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  return aiProtocolFetch(draft, url, request, transport, check);
}

type AiProtocolRequest = {
  method: "GET" | "POST" | "DELETE";
  headers: HeadersInit;
  body?: string | ArrayBuffer;
};

/** Binary and JSON protocols share the same captured authority and HTTP policy. */
export async function aiProtocolFetch(
  draft: Pick<AiConnectionDraft, "baseUrl">,
  url: URL,
  request: AiProtocolRequest,
  transport: AiConnectionTransport,
  check: () => void,
): Promise<Response> {
  assertAiRequest(draft, url, transport, check);
  const signal = AbortSignal.any([
    transport.signal,
    AbortSignal.timeout(60_000),
  ]);
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  };
  if (request.body !== undefined) init.body = request.body;
  let response: Response;
  try {
    response = await transport.fetch(url, init);
  } catch {
    check();
    transport.assertCurrent();
    transport.signal.throwIfAborted();
    throw new AiConnectionError(
      "network",
      "Could not reach this AI endpoint. Check TLS, network permissions and CORS for this origin.",
    );
  }
  try {
    check();
    transport.assertCurrent();
    transport.signal.throwIfAborted();
    checkAiResponse(response);
    if (!hasNativeResponseLifetime(response))
      bindNativeResponseLifetime(response, undefined, signal);
    aiCompletionSeams.observe?.({
      phase: "request",
      response,
      owner: check,
      httpSignal: signal,
      transportSignal: transport.signal,
    });
    return response;
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    finishAiResponseBody(response);
    throw error;
  }
}

export async function readAiJson(
  response: Response,
  check: () => void,
): Promise<BoundaryValue> {
  if (!response.body) {
    finishAiResponseBody(response);
    throw new AiConnectionError(
      "response",
      "The AI service returned no response body.",
    );
  }
  const body = aiStreamBody(
    response,
    check,
    aiResponseBodySignal(response),
    () =>
      new AiConnectionError(
        "response",
        "The AI service returned an incomplete JSON response.",
      ),
  );
  const chunks: Uint8Array[] = [];
  let length = 0;
  let value: BoundaryValue = null;
  try {
    for (;;) {
      const next = await body.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 512 * 1024)
        throw new AiConnectionError(
          "response",
          "The AI response exceeds the supported size.",
        );
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AiConnectionError(
        "response",
        "The AI service returned an unreadable JSON response.",
      );
    }
    await body.finish(length);
  } finally {
    try {
      await body.close();
    } finally {
      finishAiResponseBody(response);
    }
  }
  check();
  aiCompletionSeams.observe?.({
    phase: "body",
    response,
    owner: check,
    bytes: length,
    format: "json",
  });
  return value;
}

function assertAiRequest(
  draft: Pick<AiConnectionDraft, "baseUrl">,
  url: URL,
  transport: AiConnectionTransport,
  check: () => void,
): void {
  const base = aiConnectionBase(draft.baseUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
    throw new AiConnectionError(
      "configuration",
      "The AI request must stay within its configured endpoint.",
    );
  check();
  transport.assertCurrent();
  transport.signal.throwIfAborted();
}
