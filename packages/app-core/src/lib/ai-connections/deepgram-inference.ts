/** Finite local-file Deepgram transcription; raw audio, not multipart or chat. */
import { z } from "zod";
import type { HostedModelResult } from "../hosted-model-protocol.js";
import { aiConnectionBase } from "./configuration.js";
import {
  type DeepgramSpeechTarget,
  validateDeepgramSpeechTarget,
} from "./deepgram-target.js";
import {
  aiFiniteProtocolAuthority,
  aiProtocolFetch,
  readAiJson,
} from "./http.js";
import { type AiAudioInput, validateAiAudio } from "./media.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";

const Transcript = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(
              z.object({ transcript: z.string().trim().min(1).max(32768) }),
            )
            .min(1)
            .max(10),
        }),
      )
      .length(1),
  }),
  error: z.undefined().optional(),
  errors: z.undefined().optional(),
  err_code: z.undefined().optional(),
  err_msg: z.undefined().optional(),
  category: z.undefined().optional(),
});

/** Only the configured endpoint, known model and local bytes can shape this request. */
export async function inferDeepgramAi(
  target: DeepgramSpeechTarget,
  supplied: AiAudioInput,
  transport: AiConnectionTransport,
  owner: () => void,
): Promise<HostedModelResult> {
  const check = aiFiniteProtocolAuthority(transport, owner);
  const valid = validateDeepgramSpeechTarget(target);
  const audio = validateAiAudio(supplied);
  const url = new URL("listen", aiConnectionBase(valid.baseUrl));
  url.searchParams.set("model", valid.model);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("language", "en");
  url.searchParams.set("multichannel", "false");
  const response = await aiProtocolFetch(
    valid,
    url,
    {
      method: "POST",
      headers: {
        authorization: `Token ${valid.apiKey}`,
        "content-type": audio.mimeType,
        accept: "application/json",
      },
      body: new Uint8Array(audio.bytes).buffer,
    },
    transport,
    check,
  );
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
    const parsed = Transcript.safeParse(await readAiJson(response, check));
    const text = parsed.success
      ? parsed.data.results.channels[0]?.alternatives[0]?.transcript
      : undefined;
    if (
      !text ||
      new TextEncoder().encode(text).byteLength > 32768 ||
      text.includes(valid.apiKey)
    )
      throw new AiConnectionError(
        "response",
        "The transcription service returned an invalid or unsafe transcript.",
      );
    check();
    return { providerId: valid.providerId, model: valid.model, answer: text };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}
