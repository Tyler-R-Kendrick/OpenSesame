import { afterEach, describe, expect, it, vi } from "vitest";
import { inferDeepgramAi } from "./deepgram-inference.js";
import {
  type DeepgramSpeechTarget,
  validateDeepgramSpeechTarget,
} from "./deepgram-target.js";
import {
  DEEPGRAM_TEXT,
  DEEPGRAM_TOKEN,
  deepgramTlsFixture,
} from "./deepgram-tls.test-support.js";
import { MAX_AI_AUDIO_INPUT_BYTES } from "./media.js";
import { ownedSpeechAudio } from "./speech-tls.test-support.js";

const fixtures: Awaited<ReturnType<typeof deepgramTlsFixture>>[] = [];
async function fixture(baseUrl?: string, expectedModel?: string) {
  const local = await deepgramTlsFixture(baseUrl, expectedModel);
  fixtures.push(local);
  return local;
}
function target(
  baseUrl = "https://api.deepgram.com/v1",
  model = "nova-3",
): DeepgramSpeechTarget {
  return {
    providerId: "deepgram",
    baseUrl,
    model,
    authentication: "api-key",
    apiKey: DEEPGRAM_TOKEN,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const local of fixtures.splice(0)) await local.close();
});

describe("finite Deepgram raw audio over independently owned verified TLS", () => {
  it.each([
    "https://api.deepgram.com/v1",
    "https://speech.example/custom/runtime",
  ])(
    "consumes the exact owned raw bytes and fixed query under %s",
    async (baseUrl) => {
      const local = await fixture(baseUrl);
      const ambient = vi.fn(() => {
        throw new Error("No ambient network");
      });
      vi.stubGlobal("fetch", ambient);
      const capture = vi.fn(() => {
        throw new Error("Never reacquire authority");
      });
      local.port.capture = capture;
      const audio = ownedSpeechAudio();
      const expected = new Uint8Array(audio.bytes);
      const draft = {
        ...target(baseUrl),
        providerId: baseUrl.includes("speech.example") ? "byo-ai" : "deepgram",
      };
      const operation = inferDeepgramAi(draft, audio, local.port, () => {});
      audio.bytes.fill(0);
      expect(await operation).toEqual({
        providerId: draft.providerId,
        model: "nova-3",
        answer: DEEPGRAM_TEXT,
      });
      expect(local.records).toHaveLength(1);
      expect(local.records[0]).toMatchObject({
        method: "POST",
        authorization: `Token ${DEEPGRAM_TOKEN}`,
        mime: "audio/wav",
        accept: "application/json",
        authenticated: true,
        path: `${new URL(baseUrl).pathname}/listen?model=nova-3&smart_format=true&language=en&multichannel=false`,
      });
      expect(local.records[0]?.body).toEqual(Buffer.from(expected));
      expect(local.records[0]?.body.toString()).not.toContain(DEEPGRAM_TOKEN);
      expect(ambient).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    },
  );
  it("normalizes the MIME of actual WAV without a multipart envelope or text prompt", async () => {
    const local = await fixture();
    const { bytes } = ownedSpeechAudio();
    await expect(
      inferDeepgramAi(
        target(),
        { mimeType: "audio/wav;codecs=pcm", bytes },
        local.port,
        () => {},
      ),
    ).resolves.toMatchObject({ answer: DEEPGRAM_TEXT });
    expect(local.records[0]?.body).toEqual(Buffer.from(bytes));
    expect(local.records[0]?.mime).toBe("audio/wav");
  });
  it.each([
    ["deepgram", "https://api.deepgram.com/v1", "nova-2"],
    [
      "byo-ai",
      "https://speech.example/custom/runtime",
      "custom_model.v2-tenant",
    ],
  ])(
    "consumes configured %s transcription at %s with model %s",
    async (providerId, baseUrl, model) => {
      const local = await fixture(baseUrl, model);
      const audio = ownedSpeechAudio();
      const draft = { ...target(baseUrl, model), providerId };
      await expect(
        inferDeepgramAi(draft, audio, local.port, () => {}),
      ).resolves.toEqual({ providerId, model, answer: DEEPGRAM_TEXT });
      expect(local.records).toHaveLength(1);
      expect(local.records[0]).toMatchObject({
        method: "POST",
        path: `${new URL(baseUrl).pathname}/listen?model=${encodeURIComponent(model)}&smart_format=true&language=en&multichannel=false`,
        authorization: `Token ${DEEPGRAM_TOKEN}`,
        authenticated: true,
        body: Buffer.from(audio.bytes),
      });
    },
  );
  it("rejects a request when the TLS oracle owns a different configured model", async () => {
    const local = await fixture(undefined, "nova-3");
    await expect(
      inferDeepgramAi(
        target(undefined, "nova-2"),
        ownedSpeechAudio(),
        local.port,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "response" });
    expect(local.records[0]).toMatchObject({
      authenticated: false,
      path: "/v1/listen?model=nova-2&smart_format=true&language=en&multichannel=false",
    });
  });
  it("accepts the existing maximum local audio bound without request expansion", async () => {
    const local = await fixture();
    const audio = ownedSpeechAudio();
    const bytes = new Uint8Array(MAX_AI_AUDIO_INPUT_BYTES);
    bytes.set(audio.bytes);
    await expect(
      inferDeepgramAi(target(), { ...audio, bytes }, local.port, () => {}),
    ).resolves.toMatchObject({ answer: DEEPGRAM_TEXT });
    expect(local.records[0]?.body.byteLength).toBe(MAX_AI_AUDIO_INPUT_BYTES);
  });
  it("projects only the first alternative, without provider metadata or URLs", async () => {
    const local = await fixture();
    local.state.mode = "first-alternative";
    expect(
      await inferDeepgramAi(target(), ownedSpeechAudio(), local.port, () => {}),
    ).toEqual({
      providerId: "deepgram",
      model: "nova-3",
      answer: DEEPGRAM_TEXT,
    });
  });
  it.each([
    "unauthorized",
    "forbidden",
    "payment",
    "limited",
    "empty",
    "whitespace",
    "echo",
    "malformed",
    "provider-error",
    "category-error",
    "accepted",
    "missing-results",
    "missing-transcript",
    "extra-channel",
    "empty-alternatives",
    "wrong-mime",
    "oversized-text",
    "multibyte-text",
    "oversized-body",
  ])(
    "rejects %s without accepting a key check or exposing upstream output",
    async (mode) => {
      const local = await fixture();
      local.state.mode = mode;
      let message = "";
      try {
        await inferDeepgramAi(
          target(),
          ownedSpeechAudio(),
          local.port,
          () => {},
        );
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(DEEPGRAM_TOKEN);
      expect(message).not.toContain("must not consume");
      expect(message).not.toContain("accepted-is-not-transcribed");
      expect(local.records).toHaveLength(1);
    },
  );
  it.each([
    ["providerId", "openai"],
    ["model", "nova/2"],
    ["model", "x".repeat(101)],
    ["model", "../projects"],
    ["authentication", "none"],
    ["apiKey", ""],
    ["apiKey", "private\r\nheader"],
    ["baseUrl", "https://user:secret@unowned.example/v1"],
    [
      "baseUrl",
      "https://unowned.example/v1?callback=https://untrusted.example",
    ],
    ["baseUrl", "http://unowned.example/v1"],
    ["baseUrl", "https://unowned.example/%2e%2e/v1"],
    ["baseUrl", `https://unowned.example/${DEEPGRAM_TOKEN}`],
  ])("rejects invalid closed target %s before HTTP", async (field, value) => {
    const local = await fixture();
    await expect(
      inferDeepgramAi(
        { ...target(), [field]: value },
        ownedSpeechAudio(),
        local.port,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(local.records).toEqual([]);
  });
  it("validates public target fields without granting a missing credential", () => {
    expect(
      validateDeepgramSpeechTarget({ ...target(), apiKey: "" }, false).apiKey,
    ).toBe("");
    expect(() =>
      validateDeepgramSpeechTarget({ ...target(), apiKey: "" }),
    ).toThrow();
    expect(() =>
      validateDeepgramSpeechTarget({ ...target(), model: DEEPGRAM_TOKEN }),
    ).toThrow("Keep the API key out of public transcription fields.");
  });
  it.each(["empty", "oversized", "wrong-mime", "wrong-magic"])(
    "rejects %s audio before HTTP",
    async (mode) => {
      const local = await fixture();
      const audio = ownedSpeechAudio();
      if (mode === "empty") audio.bytes = new Uint8Array();
      if (mode === "oversized")
        audio.bytes = new Uint8Array(MAX_AI_AUDIO_INPUT_BYTES + 1);
      if (mode === "wrong-magic") audio.bytes.fill(0);
      if (mode === "wrong-mime") audio.mimeType = "text/plain";
      await expect(
        inferDeepgramAi(target(), audio, local.port, () => {}),
      ).rejects.toMatchObject({ code: "configuration" });
      expect(local.records).toEqual([]);
    },
  );
  it.each(["caller", "owner", "transport"])(
    "physically closes the original held TLS response on %s withdrawal",
    async (reason) => {
      const local = await fixture();
      local.state.mode = "held";
      const caller = new AbortController();
      const owner = new AbortController();
      const port = {
        ...local.port,
        signal: AbortSignal.any([
          local.port.signal,
          caller.signal,
          owner.signal,
        ]),
      };
      const operation = inferDeepgramAi(
        target(),
        ownedSpeechAudio(),
        port,
        () => owner.signal.throwIfAborted(),
      );
      const rejection = expect(operation).rejects.toThrow();
      await local.held;
      expect(local.records[0]).toMatchObject({
        authenticated: true,
        ended: false,
        closed: false,
      });
      if (reason === "caller") caller.abort();
      else if (reason === "owner") owner.abort();
      else local.abort.abort();
      await rejection;
      await vi.waitFor(() => expect(local.records[0]?.closed).toBe(true), {
        timeout: 5000,
      });
      expect(local.records[0]?.ended).toBe(false);
      await expect(
        inferDeepgramAi(target(), ownedSpeechAudio(), port, () =>
          owner.signal.throwIfAborted(),
        ),
      ).rejects.toThrow();
      expect(local.records).toHaveLength(1);
    },
  );
  it.each(["signal", "fetch", "assertCurrent", "owner"])(
    "rejects original %s replacement before returning a late transcript",
    async (change) => {
      const local = await fixture();
      local.state.mode = "held";
      let current = true;
      const operation = inferDeepgramAi(
        target(),
        ownedSpeechAudio(),
        local.port,
        () => {
          if (!current) throw new Error("Original owner ended");
        },
      );
      const rejection = expect(operation).rejects.toThrow();
      await local.held;
      if (change === "signal") local.port.signal = new AbortController().signal;
      if (change === "fetch") local.port.fetch = vi.fn();
      if (change === "assertCurrent") local.port.assertCurrent = () => {};
      if (change === "owner") current = false;
      local.release();
      await rejection;
      await vi.waitFor(() => expect(local.records[0]?.closed).toBe(true), {
        timeout: 5000,
      });
      expect(local.records).toHaveLength(1);
    },
  );
  it("detects reentrant authority replacement inside the owner before HTTP", async () => {
    const local = await fixture();
    await expect(
      inferDeepgramAi(target(), ownedSpeechAudio(), local.port, () => {
        local.port.signal = new AbortController().signal;
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(local.records).toEqual([]);
  });
});
