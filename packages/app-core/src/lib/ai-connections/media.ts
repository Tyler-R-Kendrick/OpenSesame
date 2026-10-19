/** Audio is transient local operation input, never a URL or saved credential. */
import { z } from "zod";
import { AiConnectionError } from "./types.js";

// Reserve multipart overhead within the native transport's 1 MiB request cap.
export const MAX_AI_AUDIO_INPUT_BYTES = 1024 * 1024 - 16 * 1024;
export type AiAudioInput = { mimeType: string; bytes: Uint8Array };
const Mime = z.enum([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
  "audio/mpeg",
]);
function tag(bytes: Uint8Array, offset: number, value: string): boolean {
  return (
    bytes.length >= offset + value.length &&
    [...value].every(
      (char, index) => bytes[offset + index] === char.charCodeAt(0),
    )
  );
}
const AUDIO_MAGIC = {
  "audio/wav": (bytes) =>
    bytes.length >= 44 && tag(bytes, 0, "RIFF") && tag(bytes, 8, "WAVE"),
  "audio/webm": (bytes) =>
    [0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value),
  "audio/ogg": (bytes) => tag(bytes, 0, "OggS"),
  "audio/mp4": (bytes) => bytes.length >= 12 && tag(bytes, 4, "ftyp"),
  "audio/mpeg": (bytes) =>
    bytes.length >= 4 &&
    (tag(bytes, 0, "ID3") ||
      (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)),
} satisfies Record<z.infer<typeof Mime>, (bytes: Uint8Array) => boolean>;

export function validateAiAudio<Value>(value: Value): AiAudioInput {
  try {
    const audio = z
      .object({ mimeType: z.string(), bytes: z.instanceof(Uint8Array) })
      .strict()
      .parse(value);
    const mime = Mime.parse(audio.mimeType.split(";")[0]?.trim().toLowerCase());
    if (
      !audio.bytes.length ||
      audio.bytes.length > MAX_AI_AUDIO_INPUT_BYTES ||
      !AUDIO_MAGIC[mime](audio.bytes)
    )
      throw new Error("Invalid audio");
    return { mimeType: mime, bytes: audio.bytes };
  } catch {
    throw new AiConnectionError(
      "configuration",
      "Choose a recognized local audio file within the 1 MiB recording/upload bound.",
    );
  }
}
