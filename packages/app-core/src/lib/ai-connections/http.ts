import type { BoundaryValue } from "@opensesame/os-domain";
import { aiCompletionSeams } from "../ai-completion-observation.js";
import { aiConnectionBase } from "./configuration.js";
import { aiConnectionHeaders, type aiInferenceRequest } from "./protocol.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiConnectionTransport,
} from "./types.js";

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
    throw error;
  }
}

export async function readAiJson(
  response: Response,
  check: () => void,
): Promise<BoundaryValue> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new AiConnectionError(
      "response",
      "The AI service returned no response body.",
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  let ended = false;
  let value: BoundaryValue = null;
  try {
    for (;;) {
      check();
      const next = await reader.read();
      ended = next.done;
      check();
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
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
