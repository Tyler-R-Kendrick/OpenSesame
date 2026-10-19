import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_AI_AUDIO_INPUT_BYTES } from "./media.js";
import { aiConnectionFamilies, aiConnectionPreset } from "./presets.js";
import { inferSpeechAi } from "./speech-inference.js";
import type { AiSpeechTarget } from "./speech-target.js";
import {
  SCRIBE_TEXT,
  SCRIBE_TOKEN,
  ownedSpeechAudio,
  speechTlsFixture,
} from "./speech-tls.test-support.js";

const fixtures: Awaited<ReturnType<typeof speechTlsFixture>>[] = [];
async function fixture(baseUrl?: string) {
  const local = await speechTlsFixture(baseUrl);
  fixtures.push(local);
  return local;
}
function target(baseUrl = "https://api.elevenlabs.io/v1"): AiSpeechTarget {
  return {
    providerId: "elevenlabs",
    baseUrl,
    model: "scribe_v2",
    authentication: "api-key",
    apiKey: SCRIBE_TOKEN,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const local of fixtures.splice(0)) await local.close();
});
describe("finite Scribe transcription over independently owned verified TLS", () => {
  it.each(["https://api.elevenlabs.io/v1", "https://speech.example/custom/v1"])(
    "consumes actual multipart local audio at %s without ambient fetch",
    async (baseUrl) => {
      const local = await fixture(baseUrl);
      const ambient = vi.fn(() => {
        throw new Error("No ambient network");
      });
      vi.stubGlobal("fetch", ambient);
      const draft = {
        ...target(baseUrl),
        providerId: baseUrl.includes("speech.example")
          ? "byo-ai"
          : "elevenlabs",
      };
      const capture = vi.fn(() => {
        throw new Error("Never reacquire the route");
      });
      local.port.capture = capture;
      const audio = ownedSpeechAudio();
      const result = await inferSpeechAi(draft, audio, local.port, () => {});
      expect(result).toEqual({
        providerId: draft.providerId,
        model: "scribe_v2",
        answer: SCRIBE_TEXT,
      });
      expect(local.records).toHaveLength(1);
      const row = local.records[0];
      expect(row).toMatchObject({
        method: "POST",
        model: "scribe_v2",
        authenticated: true,
        key: SCRIBE_TOKEN,
      });
      expect(row?.audio).toEqual(Buffer.from(audio.bytes));
      expect(row?.path).toBe(`${new URL(baseUrl).pathname}/speech-to-text`);
      expect(row?.body.toString()).not.toContain(SCRIBE_TOKEN);
      expect(JSON.stringify(result)).not.toContain(SCRIBE_TOKEN);
      expect(ambient).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    },
  );
  it("fits the largest accepted local audio inside the serialized native request bound", async () => {
    const local = await fixture();
    const original = ownedSpeechAudio();
    const bytes = new Uint8Array(MAX_AI_AUDIO_INPUT_BYTES);
    bytes.set(original.bytes);
    await expect(
      inferSpeechAi(target(), { ...original, bytes }, local.port, () => {}),
    ).resolves.toMatchObject({ answer: SCRIBE_TEXT });
    expect(local.records[0]?.body.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(local.records[0]?.audio?.byteLength).toBe(MAX_AI_AUDIO_INPUT_BYTES);
  });
  it("rejects oversized serialization before network even if the local serializer changes", async () => {
    const local = await fixture();
    vi.spyOn(Request.prototype, "arrayBuffer").mockResolvedValueOnce(
      new ArrayBuffer(1024 * 1024 + 1),
    );
    await expect(
      inferSpeechAi(target(), ownedSpeechAudio(), local.port, () => {}),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(local.records).toHaveLength(0);
  });
  it.each([
    "unauthorized",
    "forbidden",
    "empty",
    "echo",
    "malformed",
    "provider-error",
    "wrong-mime",
    "oversized-text",
    "multibyte-text",
    "oversized-body",
  ])("rejects %s without returning provider/private output", async (mode) => {
    const local = await fixture();
    local.state.mode = mode;
    let message = "";
    try {
      await inferSpeechAi(target(), ownedSpeechAudio(), local.port, () => {});
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(SCRIBE_TOKEN);
    expect(message).not.toContain("must not consume");
    expect(local.records).toHaveLength(1);
  });
  it.each([
    ["providerId", "openai"],
    ["model", "../account"],
    ["authentication", "none"],
    ["apiKey", ""],
    ["apiKey", "private\r\nheader"],
    ["baseUrl", "https://private:secret@unowned.example/v1"],
    ["baseUrl", "https://unowned.example/v1?key=credential"],
  ])(
    "rejects an invalid closed target before network: %s",
    async (field, value) => {
      const local = await fixture();
      await expect(
        inferSpeechAi(
          { ...target(), [field]: value },
          ownedSpeechAudio(),
          local.port,
          () => {},
        ),
      ).rejects.toMatchObject({ code: "configuration" });
      expect(local.records).toHaveLength(0);
    },
  );
  it("does not activate the provider or family before complete configuration/UI", () => {
    expect(aiConnectionPreset("elevenlabs")).toBeNull();
    expect(
      aiConnectionFamilies("byo-ai").map((family) => family.id),
    ).not.toContain("elevenlabs_scribe");
  });
  it("physically closes a held TLS stream on original owner withdrawal without a late answer", async () => {
    const local = await fixture();
    local.state.mode = "held";
    const operation = inferSpeechAi(
      target(),
      ownedSpeechAudio(),
      local.port,
      () => {},
    );
    const rejection = expect(operation).rejects.toThrow();
    await local.held;
    expect(local.records[0]).toMatchObject({
      authenticated: true,
      ended: false,
      closed: false,
    });
    local.abort.abort();
    await rejection;
    await vi.waitFor(() => expect(local.records[0]?.closed).toBe(true));
    expect(local.records[0]?.ended).toBe(false);
    await expect(
      inferSpeechAi(target(), ownedSpeechAudio(), local.port, () => {}),
    ).rejects.toThrow();
    expect(local.records).toHaveLength(1);
  });
  it.each(["abort", "signal", "fetch", "assertCurrent", "owner"])(
    "retains the original transport across multipart serialization: %s",
    async (change) => {
      const local = await fixture();
      let current = true;
      const serialize = Request.prototype.arrayBuffer;
      vi.spyOn(Request.prototype, "arrayBuffer").mockImplementationOnce(
        async function (this: Request) {
          const body = await serialize.call(this);
          if (change === "abort") local.abort.abort();
          if (change === "signal")
            local.port.signal = new AbortController().signal;
          if (change === "fetch") local.port.fetch = vi.fn();
          if (change === "assertCurrent") local.port.assertCurrent = () => {};
          if (change === "owner") current = false;
          return body;
        },
      );
      await expect(
        inferSpeechAi(target(), ownedSpeechAudio(), local.port, () => {
          if (!current) throw new Error("Original owner ended");
        }),
      ).rejects.toThrow();
      expect(local.records).toHaveLength(0);
    },
  );
  it("rejects withdrawal inside an owner callback before HTTP", async () => {
    const local = await fixture();
    await expect(
      inferSpeechAi(target(), ownedSpeechAudio(), local.port, () => {
        local.port.signal = new AbortController().signal;
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(local.records).toHaveLength(0);
  });
});
