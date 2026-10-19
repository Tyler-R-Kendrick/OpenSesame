import { describe, expect, it } from "vitest";
import { MAX_AI_AUDIO_INPUT_BYTES, validateAiAudio } from "./media.js";

function audio(mimeType = "audio/wav", length = 44) {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode("RIFF"));
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return { mimeType, bytes };
}
describe("local audio boundary", () => {
  it.each([
    ["audio/webm;codecs=opus", [0x1a, 0x45, 0xdf, 0xa3]],
    ["audio/ogg", [79, 103, 103, 83]],
    ["audio/mpeg", [73, 68, 51, 0]],
    ["audio/mpeg", [255, 251, 0, 0]],
    ["audio/mp4", [0, 0, 0, 0, 102, 116, 121, 112, 0, 0, 0, 0]],
  ])("accepts recognized %s bytes", (mimeType, data) => {
    const bytes = new Uint8Array(data);
    expect(validateAiAudio({ mimeType, bytes })).toEqual({
      mimeType: mimeType.split(";")[0],
      bytes,
    });
  });
  it("normalizes WAV MIME and retains only bounded operation input", () => {
    const input = audio(" Audio/WAV ");
    expect(validateAiAudio(input)).toEqual({
      mimeType: "audio/wav",
      bytes: input.bytes,
    });
    expect(
      validateAiAudio(audio("audio/wav", MAX_AI_AUDIO_INPUT_BYTES)).bytes
        .length,
    ).toBe(MAX_AI_AUDIO_INPUT_BYTES);
  });
  it.each([
    {},
    { mimeType: "audio/wav", bytes: [82, 73, 70, 70] },
    { mimeType: "audio/wav", bytes: new Uint8Array() },
    { mimeType: "audio/ogg", bytes: new Uint8Array([79, 103, 103]) },
    { mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) },
    { ...audio(), source_url: "https://unowned.example/audio" },
    { ...audio(), webhook: true },
    audio("audio/wav", 43),
    audio("audio/wav", MAX_AI_AUDIO_INPUT_BYTES + 1),
    audio("text/plain"),
  ])("rejects malformed, remote or oversized input %#", (input) => {
    expect(() => validateAiAudio(input)).toThrow("recognized local audio");
  });
});
