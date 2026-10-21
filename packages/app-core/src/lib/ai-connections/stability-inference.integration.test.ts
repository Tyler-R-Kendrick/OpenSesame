import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedModelInput } from "../hosted-model-protocol.js";
import { inferStabilityAi } from "./stability-inference.js";
import { readStabilityJson } from "./stability-response.js";
import {
  STABILITY_SD3_BASE,
  type StabilityAiTarget,
} from "./stability-target.js";
import {
  RASTER_FIXTURES,
  STABILITY_KEY,
  STABILITY_PROMPT,
  stabilityTlsFixture,
} from "./stability-tls.test-support.js";
const active: Awaited<ReturnType<typeof stabilityTlsFixture>>[] = [];
async function fixture(base?: string, model?: string) {
  const result = await stabilityTlsFixture(base, model);
  active.push(result);
  return result;
}
function target(
  baseUrl = STABILITY_SD3_BASE,
  model = "sd3.5-medium",
): StabilityAiTarget {
  return {
    providerId: baseUrl === STABILITY_SD3_BASE ? "stability" : "byo-ai",
    baseUrl,
    model,
    authentication: "api-key",
    apiKey: STABILITY_KEY,
  };
}
function input(model = "sd3.5-medium"): HostedModelInput {
  return { model, messages: [{ role: "user", content: STABILITY_PROMPT }] };
}
async function pause(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
async function closed(row: { closed: boolean }) {
  const start = performance.now();
  while (!row.closed && performance.now() - start < 1500) await pause(10);
  expect(row.closed).toBe(true);
  expect(performance.now() - start).toBeLessThan(2000);
}
afterEach(async () => {
  for (const item of active.splice(0)) await item.close();
  vi.restoreAllMocks();
});
describe("official finite Stability SD3 over independently verified owned HTTPS", () => {
  it.each([
    [STABILITY_SD3_BASE, "sd3.5-medium"],
    [STABILITY_SD3_BASE, "sd3.5-large-turbo"],
    ["https://images.example/custom/stable/", "custom-medium"],
  ])(
    "sends saved exact target/model %s %s and consumes raster bytes",
    async (base, model) => {
      const local = await fixture(base, model);
      const cancelReader = vi.spyOn(
        ReadableStreamDefaultReader.prototype,
        "cancel",
      );
      const cancelBody = vi.spyOn(ReadableStream.prototype, "cancel");
      const draft = target(base, model);
      let acquisitions = 0;
      local.port.capture = () => {
        acquisitions++;
        throw new Error("Do not reacquire");
      };
      const result = await inferStabilityAi(
        draft,
        input(model),
        local.port,
        () => {},
      );
      expect(result).toMatchObject({
        providerId: draft.providerId,
        model,
        image: { mimeType: "image/png", width: 2, height: 3, seed: 23 },
      });
      expect(result.image.copyBytes()).toEqual(
        new Uint8Array(Buffer.from(RASTER_FIXTURES.png, "base64")),
      );
      expect(JSON.stringify(result)).not.toContain(STABILITY_KEY);
      expect(JSON.stringify(result)).not.toContain(RASTER_FIXTURES.png);
      expect(local.records).toHaveLength(1);
      expect(local.records[0].path).toBe(
        `${new URL(base).pathname.replace(/\/$/, "")}/generate/sd3`,
      );
      expect(local.records[0].headers["content-type"]).toMatch(
        /^multipart\/form-data; boundary=/,
      );
      expect(local.records[0].fields).toEqual([
        ["prompt", STABILITY_PROMPT],
        ["model", model],
        ["mode", "text-to-image"],
        ["aspect_ratio", "1:1"],
        ["output_format", "png"],
      ]);
      expect(acquisitions).toBe(0);
      expect(cancelReader).not.toHaveBeenCalled();
      expect(cancelBody).not.toHaveBeenCalled();
      result.image.release();
    },
  );
  it("accepts officially optional seed", async () => {
    const local = await fixture();
    local.state.mode = "no-seed";
    const result = await inferStabilityAi(
      target(),
      input(),
      local.port,
      () => {},
    );
    expect(result.image.seed).toBeUndefined();
    result.image.release();
  });
  it.each([
    "http-400",
    "http-401",
    "http-402",
    "http-403",
    "http-413",
    "http-422",
    "http-429",
    "http-500",
    "filtered",
    "echo",
    "decoded-echo",
    "jpeg",
    "bad-base64",
    "no-image",
    "unknown",
    "malformed",
    "wrong-mime",
    "oversized",
  ])("rejects %s without provider/private output or retry", async (mode) => {
    const local = await fixture();
    const cancelBody = vi.spyOn(ReadableStream.prototype, "cancel");
    local.state.mode = mode;
    const result = await inferStabilityAi(
      target(),
      input(),
      local.port,
      () => {},
    ).then(
      () => ({ message: "UNEXPECTED_SUCCESS" }),
      (error) => ({
        message: error instanceof Error ? error.message : "error",
      }),
    );
    expect(result.message).not.toBe("UNEXPECTED_SUCCESS");
    expect(result.message).not.toContain(STABILITY_KEY);
    expect(result.message).not.toContain(RASTER_FIXTURES.png);
    expect(local.records).toHaveLength(1);
    if (mode === "filtered") expect(result.message).toContain("filtered");
    if (["wrong-mime", "http-400", "http-401"].includes(mode))
      expect(cancelBody).toHaveBeenCalledOnce();
  });
  it("cancels a partial image JSON producer without replacing the original owner error", async () => {
    const initiating = new Error("Original image owner ended");
    const cancel = vi.fn(() => Promise.reject(new Error("Cancel failed")));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"image":'));
        },
        cancel,
      }),
    );
    let checks = 0;
    await expect(
      readStabilityJson(response, new AbortController().signal, () => {
        if (++checks === 2) throw initiating;
      }),
    ).rejects.toBe(initiating);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
    expect(response.body?.locked).toBe(false);
  });
  it("rejects chat/media/token/model/path misuse before egress", async () => {
    const local = await fixture();
    for (const supplied of [
      { ...input(), maxOutputTokens: 1 },
      {
        ...input(),
        media: {
          mimeType: "audio/webm",
          bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
        },
      },
      {
        ...input(),
        messages: [{ role: "system" as const, content: STABILITY_PROMPT }],
      },
      { ...input(), messages: [...input().messages, ...input().messages] },
      { ...input(), model: "different-model" },
      {
        ...input(),
        messages: [{ role: "user" as const, content: STABILITY_KEY }],
      },
      {
        ...input(),
        messages: [{ role: "user" as const, content: "x".repeat(8193) }],
      },
    ])
      await expect(
        inferStabilityAi(target(), supplied, local.port, () => {}),
      ).rejects.toMatchObject({ code: "configuration" });
    for (const draft of [
      { ...target(), baseUrl: "https://images.example/other" },
      { ...target(), model: "../../escape" },
      { ...target(), apiKey: "bad\nkey" },
      {
        ...target(),
        baseUrl: "https://api.stability.ai/v2beta/stable-image?other=1",
      },
    ])
      await expect(
        inferStabilityAi(draft, input(), local.port, () => {}),
      ).rejects.toBeDefined();
    expect(local.records).toHaveLength(0);
  });
  it.each(["caller", "route", "owner"])(
    "physically closes a held body for %s withdrawal within2s, not60s deadline",
    async (reason) => {
      const local = await fixture();
      local.state.mode = "hold-body";
      const caller = new AbortController();
      const capturedOwner = new AbortController();
      let owned = true;
      const operation = inferStabilityAi(
        target(),
        input(),
        local.port,
        () => {
          if (!owned) throw new Error("Saved row withdrawn");
        },
        { signal: reason === "owner" ? capturedOwner.signal : caller.signal },
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      await local.ready;
      await pause(250);
      expect(local.records[0].closed).toBe(false);
      const start = performance.now();
      if (reason === "route") local.withdraw();
      else {
        if (reason === "owner") {
          owned = false;
          capturedOwner.abort();
        } else caller.abort();
      }
      await closed(local.records[0]);
      expect(performance.now() - start).toBeLessThan(2000);
      expect((await operation).ok).toBe(false);
    },
  );
  it("cancels a held unauthorized response body immediately without caller abort", async () => {
    const local = await fixture();
    local.state.mode = "held-error";
    const started = performance.now();
    await expect(
      inferStabilityAi(target(), input(), local.port, () => {}),
    ).rejects.toMatchObject({ code: "authentication" });
    await closed(local.records[0]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(local.records).toHaveLength(1);
  });
  it("bounds response body lifetime after headers and cancels physical socket", async () => {
    const local = await fixture();
    local.state.mode = "hold-body";
    const operation = inferStabilityAi(
      target(),
      input(),
      local.port,
      () => {},
      { timeoutMs: 400 },
    ).then(
      () => true,
      () => false,
    );
    await local.ready;
    await pause(150);
    expect(local.records[0].closed).toBe(false);
    expect(await operation).toBe(false);
    await closed(local.records[0]);
  });
  it("rejects original method replacement during held HTTP and never adopts the new port", async () => {
    const local = await fixture();
    local.state.mode = "hold-body";
    const caller = new AbortController();
    let replacement = 0;
    const operation = inferStabilityAi(
      target(),
      input(),
      local.port,
      () => {},
      { signal: caller.signal },
    ).then(
      () => true,
      () => false,
    );
    await local.ready;
    local.port.fetch = async () => {
      replacement++;
      throw new Error("New route must not be used");
    };
    caller.abort();
    expect(await operation).toBe(false);
    await closed(local.records[0]);
    expect(replacement).toBe(0);
    expect(local.records).toHaveLength(1);
  });
  it("fails withdrawn original ownership before local serialization or egress", async () => {
    const local = await fixture();
    local.withdraw();
    await expect(
      inferStabilityAi(target(), input(), local.port, () => {}),
    ).rejects.toBeDefined();
    expect(local.records).toHaveLength(0);
  });
  it.each([0, 60001, Number.POSITIVE_INFINITY])(
    "does not widen deadline %s",
    async (timeoutMs) => {
      const local = await fixture();
      await expect(
        inferStabilityAi(target(), input(), local.port, () => {}, {
          timeoutMs,
        }),
      ).rejects.toMatchObject({ code: "configuration" });
      expect(local.records).toHaveLength(0);
    },
  );
});
