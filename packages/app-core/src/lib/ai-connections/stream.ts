import { isJsonObject, isString } from "@opensesame/os-domain";
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  aiCompletionSeams,
  aiResponseBodySignal,
  finishAiResponseBody,
} from "./http.js";
import { aiStreamBody } from "./stream-body.js";
import {
  AiConnectionError,
  type AiInferenceFamily,
  textAiFamily,
} from "./types.js";

function malformed(): AiConnectionError {
  return new AiConnectionError(
    "response",
    "The AI service returned an invalid or incomplete text stream.",
  );
}

function chatDelta(value: BoundaryValue) {
  if (!isJsonObject(value) || value.error) throw malformed();
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
  if (!choice) return "";
  if (!isJsonObject(choice) || !isJsonObject(choice.delta)) throw malformed();
  const text = choice.delta.content;
  if (text !== undefined && text !== null && !isString(text)) throw malformed();
  return isString(text) ? text : "";
}

function anthropicDelta(value: BoundaryValue) {
  if (!isJsonObject(value) || value.type === "error") throw malformed();
  if (value.type === "content_block_delta") {
    if (!isJsonObject(value.delta)) throw malformed();
    return value.delta.type === "text_delta" && isString(value.delta.text)
      ? value.delta.text
      : "";
  }
  if (value.type === "content_block_start" && isJsonObject(value.content_block))
    return value.content_block.type === "text" &&
      isString(value.content_block.text)
      ? value.content_block.text
      : "";
  return "";
}

function geminiDelta(value: BoundaryValue) {
  if (!isJsonObject(value) || value.error) throw malformed();
  const candidate = Array.isArray(value.candidates)
    ? value.candidates[0]
    : undefined;
  if (!candidate || !isJsonObject(candidate)) throw malformed();
  const parts = isJsonObject(candidate.content)
    ? candidate.content.parts
    : undefined;
  if (parts !== undefined && !Array.isArray(parts)) throw malformed();
  return {
    text: Array.isArray(parts)
      ? parts
          .map((part) => {
            if (!isJsonObject(part)) throw malformed();
            return isString(part.text) && !part.thought ? part.text : "";
          })
          .join("")
      : "",
    done: isString(candidate.finishReason),
  };
}

function responsesDelta(value: BoundaryValue) {
  if (
    !isJsonObject(value) ||
    value.type === "error" ||
    value.type === "response.failed" ||
    value.type === "response.incomplete"
  )
    throw malformed();
  if (value.type === "response.output_text.delta" && !isString(value.delta))
    throw malformed();
  return {
    text:
      value.type === "response.output_text.delta" && isString(value.delta)
        ? value.delta
        : "",
    done: value.type === "response.completed",
  };
}

function streamFrame(family: AiInferenceFamily, data: string) {
  if (data === "[DONE]" && family === "openai_chat")
    return { text: "", done: true };
  let value: BoundaryValue;
  try {
    value = JSON.parse(data);
  } catch {
    throw malformed();
  }
  if (family === "gemini_generate_content") return geminiDelta(value);
  if (family === "openai_responses") return responsesDelta(value);
  return {
    text: family === "openai_chat" ? chatDelta(value) : anthropicDelta(value),
    done:
      family === "anthropic_messages" &&
      isJsonObject(value) &&
      value.type === "message_stop",
  };
}

/** SSE framing is shared; each provider decodes its own event and completion protocol. */
export async function readAiTextStream(
  response: Response,
  family: AiInferenceFamily,
  onText: (text: string) => void,
  check: () => void,
  signal: AbortSignal,
): Promise<string> {
  // Unsupported families never transfer response-body custody to this parser.
  textAiFamily(family);
  let body: ReturnType<typeof aiStreamBody> | undefined;
  const decoder = new TextDecoder();
  let pending = "";
  let answer = "";
  let bytes = 0;
  let completed = false;
  function consume(frame: string) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (completed) throw malformed();
    const result = streamFrame(family, data);
    completed = result.done;
    if (!result.text) return;
    answer += result.text;
    if (answer.length > 32768) throw malformed();
    check();
    onText(result.text);
  }
  try {
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("text/event-stream")
    )
      throw malformed();
    const requestSignal = aiResponseBodySignal(response);
    body = aiStreamBody(
      response,
      check,
      requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
      malformed,
    );
    for (;;) {
      const next = await body.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw malformed();
      pending = (
        pending + decoder.decode(next.value, { stream: true })
      ).replace(/\r\n/g, "\n");
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        consume(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf("\n\n");
      }
      if (pending.length > 256 * 1024) throw malformed();
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
    if (!completed || !answer.trim()) throw malformed();
    check();
    await body.finish(bytes);
  } finally {
    try {
      if (body) await body.close();
      else await response.body?.cancel().catch(() => undefined);
    } finally {
      finishAiResponseBody(response);
    }
  }
  aiCompletionSeams.observe?.({
    phase: "body",
    response,
    owner: check,
    bytes,
    format: "sse",
  });
  return answer;
}
