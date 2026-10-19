/** Finite local-file Scribe operation: no webhooks, source URLs or generic chat. */
import { z } from "zod";
import type { HostedModelResult } from "../hosted-model-protocol.js";
import { aiConnectionBase } from "./configuration.js";
import { aiProtocolFetch, readAiJson } from "./http.js";
import { type AiAudioInput, validateAiAudio } from "./media.js";
import {
  type AiSpeechTarget,
  validateAiSpeechTarget,
} from "./speech-target.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";

function speechAuthority(transport: AiConnectionTransport, owner: () => void) {
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
async function scribeRequest(target: AiSpeechTarget, supplied: AiAudioInput) {
  const audio = validateAiAudio(supplied);
  const url = new URL("speech-to-text", aiConnectionBase(target.baseUrl));
  const data = new FormData();
  data.set("model_id", target.model);
  data.set(
    "file",
    new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }),
    "recording.audio",
  );
  // Local serialization only; authority is rechecked before the first HTTP request.
  const serialized = new Request(url, { method: "POST", body: data });
  const body = await serialized.arrayBuffer();
  if (body.byteLength > 1024 * 1024)
    throw new AiConnectionError(
      "configuration",
      "The transcription request exceeds the 1 MiB native request bound.",
    );
  const headers = new Headers(serialized.headers);
  headers.set("xi-api-key", target.apiKey);
  headers.set("accept", "application/json");
  return { url, request: { method: "POST" as const, headers, body } };
}
const Transcript = z.object({
  text: z.string().trim().min(1).max(32768),
  error: z.undefined().optional(),
  errors: z.undefined().optional(),
});
export async function inferSpeechAi(
  target: AiSpeechTarget,
  audio: AiAudioInput,
  transport: AiConnectionTransport,
  owner: () => void,
): Promise<HostedModelResult> {
  const check = speechAuthority(transport, owner);
  const valid = validateAiSpeechTarget(target);
  const { url, request } = await scribeRequest(valid, audio);
  check();
  const response = await aiProtocolFetch(valid, url, request, transport, check);
  try {
    if (
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      throw new AiConnectionError(
        "response",
        "The transcription service returned an invalid content type.",
      );
    const transcript = Transcript.safeParse(await readAiJson(response, check));
    if (
      !transcript.success ||
      new TextEncoder().encode(transcript.data.text).byteLength > 32768 ||
      transcript.data.text.includes(valid.apiKey)
    )
      throw new AiConnectionError(
        "response",
        "The transcription service returned an invalid or unsafe transcript.",
      );
    check();
    return {
      providerId: valid.providerId,
      model: valid.model,
      answer: transcript.data.text,
    };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}
