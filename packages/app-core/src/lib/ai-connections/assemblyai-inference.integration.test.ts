import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inferAssemblyAi } from "./assemblyai-inference.js";
import type { AssemblySpeechTarget } from "./assemblyai-target.js";
import {
  ASSEMBLY_KEY,
  ASSEMBLY_TEXT,
  assemblyTlsFixture,
} from "./assemblyai-tls.test-support.js";
import { MAX_AI_AUDIO_INPUT_BYTES } from "./media.js";
import { ownedSpeechAudio } from "./speech-tls.test-support.js";
const fixtures: Awaited<ReturnType<typeof assemblyTlsFixture>>[] = [];
async function fixture(options?: Parameters<typeof assemblyTlsFixture>[0]) {
  const local = await assemblyTlsFixture(options);
  fixtures.push(local);
  return local;
}
function target(
  baseUrl = "https://api.assemblyai.com/v2",
  model = "universal-3-5-pro",
  providerId = "assemblyai",
): AssemblySpeechTarget {
  return {
    providerId,
    baseUrl,
    model,
    authentication: "api-key",
    apiKey: ASSEMBLY_KEY,
  };
}
beforeEach(() => {
  // Accelerate only the requested production 2s pauses; TLS remains real and serial.
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (handler, delay, ...args) =>
      timer(handler, delay === 2000 ? 1 : delay, ...args),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const local of fixtures.splice(0)) await local.close();
});
describe("AssemblyAI finite prerecorded protocol over independently owned verified TLS", () => {
  it.each([
    [
      "assemblyai",
      "https://api.assemblyai.com/v2",
      "universal-3-5-pro",
      "https://cdn.assemblyai.com/upload/owned-local-audio",
    ],
    [
      "assemblyai",
      "https://api.eu.assemblyai.com/v2",
      "universal-2",
      "https://eu-audio.example/opaque/tenant?handle=42",
    ],
    [
      "byo-ai",
      "https://speech.example/operator/mount",
      "custom_model.v2-tenant",
      "https://operator-cdn.example/audio/owned",
    ],
  ])(
    "transcribes and deletes at configured %s/%s/%s using opaque upload %s",
    async (providerId, baseUrl, model, upload) => {
      const local = await fixture({ baseUrl, model, upload });
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
      const promise = inferAssemblyAi(
        target(baseUrl, model, providerId),
        audio,
        local.port,
        () => {},
      );
      audio.bytes.fill(0);
      expect(await promise).toEqual({
        providerId,
        model,
        answer: ASSEMBLY_TEXT,
      });
      expect(local.records.map((row) => [row.method, row.path])).toEqual([
        ["POST", `${new URL(baseUrl).pathname}/upload`],
        ["POST", `${new URL(baseUrl).pathname}/transcript`],
        ["GET", `${new URL(baseUrl).pathname}/transcript/${local.id}`],
        ["GET", `${new URL(baseUrl).pathname}/transcript/${local.id}`],
        ["DELETE", `${new URL(baseUrl).pathname}/transcript/${local.id}`],
      ]);
      expect(
        local.records.every(
          (row) =>
            row.authenticated &&
            row.authorization === ASSEMBLY_KEY &&
            row.accept === "application/json",
        ),
      ).toBe(true);
      expect(local.records[0]).toMatchObject({
        mime: "application/octet-stream",
        body: Buffer.from(expected),
      });
      expect(JSON.parse(local.records[1]?.body.toString() ?? "")).toEqual({
        audio_url: upload,
        speech_models: [model],
        language_code: "en",
      });
      expect(local.records[1]?.body.toString()).not.toContain(ASSEMBLY_KEY);
      expect(
        local.records.slice(2).every((row) => !row.body.length && !row.mime),
      ).toBe(true);
      expect(ambient).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      expect(
        vi.mocked(setTimeout).mock.calls.filter((call) => call[1] === 2000),
      ).toHaveLength(2);
    },
  );
  it("uses one bounded safe custom job segment only from its BYO create response", async () => {
    const local = await fixture({
      baseUrl: "https://speech.example/custom",
      id: "tenant-job_1",
      model: "custom-model",
    });
    await expect(
      inferAssemblyAi(
        target(local.baseUrl, "custom-model", "byo-ai"),
        ownedSpeechAudio(),
        local.port,
        () => {},
      ),
    ).resolves.toMatchObject({ answer: ASSEMBLY_TEXT });
    expect(local.records.at(-1)?.path).toBe("/custom/transcript/tenant-job_1");
  });
  it.each(["wav", "webm", "maximum"])(
    "uploads actual %s bytes without multipart or prompt expansion",
    async (mode) => {
      const local = await fixture();
      const audio = ownedSpeechAudio();
      if (mode === "webm") {
        audio.mimeType = "audio/webm";
        audio.bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 4, 5]);
      }
      if (mode === "maximum") {
        const bytes = new Uint8Array(MAX_AI_AUDIO_INPUT_BYTES);
        bytes.set(audio.bytes);
        audio.bytes = bytes;
      }
      await expect(
        inferAssemblyAi(target(), audio, local.port, () => {}),
      ).resolves.toMatchObject({ answer: ASSEMBLY_TEXT });
      expect(local.records[0]?.body).toEqual(Buffer.from(audio.bytes));
    },
  );
  it("requires the oracle's independently configured exact model", async () => {
    const local = await fixture({ model: "universal-2" });
    await expect(
      inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
    ).rejects.toThrow();
    expect(local.records.map((row) => row.method)).toEqual(["POST", "POST"]);
    expect(local.records[1]?.authenticated).toBe(false);
  });
  it("allows optional nullable model metadata without substituting the saved model", async () => {
    const local = await fixture();
    local.state.mode = "nullable-model";
    await expect(
      inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
    ).resolves.toEqual({
      providerId: "assemblyai",
      model: "universal-3-5-pro",
      answer: ASSEMBLY_TEXT,
    });
  });
  it.each([
    "unauthorized",
    "forbidden",
    "limited",
    "redirect",
    "malformed",
    "wrong-mime",
    "oversized-body",
    "metadata-echo",
  ])(
    "never treats %s upload as useful transcription or retries creation",
    async (mode) => {
      const local = await fixture();
      local.state.phase = "upload";
      local.state.mode = mode;
      await expect(
        inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
      ).rejects.toThrow();
      expect(local.records.map((row) => row.phase)).toEqual(["upload"]);
    },
  );
  it.each([
    "http://cdn.example/upload/owned",
    "https://user:secret@cdn.example/upload/owned",
    "https://cdn.example/upload/owned#secret",
    "https://cdn.example/white space",
    `https://cdn.example/${ASSEMBLY_KEY}`,
    `https://cdn.example/${encodeURIComponent(ASSEMBLY_KEY).replace("owned", "%6fwned")}`,
    "https://cdn.example/%ZZ",
    `https://cdn.example/${"x".repeat(2048)}`,
    "data:audio/wav;base64,AAAA",
  ])("rejects unsafe opaque handle %s without following it", async (upload) => {
    const local = await fixture();
    local.state.uploadUrl = upload;
    await expect(
      inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
    ).rejects.toThrow();
    expect(local.records.map((row) => row.phase)).toEqual(["upload"]);
  });
  it.each([
    "wrong-id",
    "bad-id",
    "unknown-status",
    "wrong-model",
    "provider-error",
    "error-and-text",
    "empty",
    "whitespace",
    "large-text",
    "unicode-text",
    "echo",
    "metadata-echo",
    "deleted",
    "malformed",
    "wrong-mime",
    "oversized-body",
    "unauthorized",
    "forbidden",
    "limited",
    "redirect",
  ])(
    "rejects %s job output and actually deletes the originally created job",
    async (mode) => {
      const local = await fixture();
      local.state.mode = mode;
      let message = "";
      try {
        await inferAssemblyAi(
          target(),
          ownedSpeechAudio(),
          local.port,
          () => {},
        );
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(ASSEMBLY_KEY);
      expect(message).not.toContain("upstream-private-failure");
      expect(local.records.at(-1)).toMatchObject({
        phase: "delete",
        path: `/v2/transcript/${local.id}`,
        method: "DELETE",
        authenticated: true,
      });
      expect(
        local.records.filter((row) => row.phase === "delete"),
      ).toHaveLength(1);
      expect(
        local.records.filter((row) => row.phase === "create"),
      ).toHaveLength(1);
    },
  );
  it.each(["provider-error", "wrong-model", "unknown-status", "metadata-echo"])(
    "captures the valid created ID before rejecting %s create metadata, then deletes it",
    async (mode) => {
      const local = await fixture();
      local.state.phase = "create";
      local.state.mode = mode;
      await expect(
        inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
      ).rejects.toThrow();
      expect(local.records.map((row) => row.phase)).toEqual([
        "upload",
        "create",
        "delete",
      ]);
    },
  );
  it.each(["bad-id", "id-echo", "malformed", "unauthorized"])(
    "does not guess/list/delete a job after %s unknown create outcome",
    async (mode) => {
      const local = await fixture();
      local.state.phase = "create";
      local.state.mode = mode;
      await expect(
        inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
      ).rejects.toThrow();
      expect(local.records.map((row) => row.phase)).toEqual([
        "upload",
        "create",
      ]);
    },
  );
  it.each([
    "unauthorized",
    "wrong-id",
    "metadata-echo",
    "malformed",
    "wrong-mime",
    "oversized-body",
  ])(
    "does not admit a transcript when %s DELETE lacks a safe same-ID acknowledgment",
    async (mode) => {
      const local = await fixture();
      local.state.phase = "delete";
      local.state.mode = mode;
      await expect(
        inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
      ).rejects.toThrow("Remote transcript removal was not confirmed");
      expect(
        local.records.filter((row) => row.phase === "delete"),
      ).toHaveLength(1);
    },
  );
  it("bounds serial polling to sixty GETs and deletes instead of accepting queued text", async () => {
    const local = await fixture();
    local.state.statuses = ["queued"];
    await expect(
      inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}),
    ).rejects.toThrow("finite polling bound");
    expect(local.records.filter((row) => row.phase === "poll")).toHaveLength(
      60,
    );
    expect(local.records.at(-1)?.phase).toBe("delete");
    expect(
      vi.mocked(setTimeout).mock.calls.filter((call) => call[1] === 2000),
    ).toHaveLength(60);
  });
  it.each([
    ["providerId", "openai"],
    ["authentication", "none"],
    ["model", "universal/2"],
    ["model", "x".repeat(101)],
    ["apiKey", ""],
    ["apiKey", "key\r\nheader"],
    ["model", ASSEMBLY_KEY],
    ["baseUrl", `https://api.example/${ASSEMBLY_KEY}`],
    ["baseUrl", "https://user:secret@api.example/v2"],
    ["baseUrl", "https://api.example/v2?callback=foreign"],
    ["baseUrl", "http://api.example/v2"],
  ])("rejects invalid %s target before any HTTP", async (field, value) => {
    const local = await fixture();
    await expect(
      inferAssemblyAi(
        { ...target(), [field]: value },
        ownedSpeechAudio(),
        local.port,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(local.records).toEqual([]);
  });
  it.each(["empty", "oversized", "mime", "magic"])(
    "rejects %s local audio without dispatch",
    async (mode) => {
      const local = await fixture();
      const audio = ownedSpeechAudio();
      if (mode === "empty") audio.bytes = new Uint8Array();
      if (mode === "oversized")
        audio.bytes = new Uint8Array(MAX_AI_AUDIO_INPUT_BYTES + 1);
      if (mode === "mime") audio.mimeType = "text/plain";
      if (mode === "magic") audio.bytes.fill(0);
      await expect(
        inferAssemblyAi(target(), audio, local.port, () => {}),
      ).rejects.toThrow();
      expect(local.records).toEqual([]);
    },
  );
  it.each([0, 99, 180001, Number.NaN])(
    "rejects a widening/invalid %s workflow budget",
    async (timeoutMs) => {
      const local = await fixture();
      await expect(
        inferAssemblyAi(target(), ownedSpeechAudio(), local.port, () => {}, {
          timeoutMs,
        }),
      ).rejects.toThrow();
      expect(local.records).toEqual([]);
    },
  );
});
