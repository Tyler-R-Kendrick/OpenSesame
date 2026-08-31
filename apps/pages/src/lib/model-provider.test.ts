import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserInferencePlane,
  BrowserInferenceVerdict,
} from "./browser-inference.js";
import { kvGet, kvSetDurable } from "./kv.js";
import {
  MODEL_PROVIDER_KEY,
  type ModelProviderRecord,
  NO_MODEL_PROVIDER,
  autonomousResetAvailable,
  loadModelProvider,
  modelProviderSeams,
  resolveModelPlane,
  saveModelProvider,
} from "./model-provider.js";

const original = { ...modelProviderSeams };

beforeEach(async () => {
  await kvSetDurable(MODEL_PROVIDER_KEY, "");
});

afterEach(() => {
  Object.assign(modelProviderSeams, original);
  vi.restoreAllMocks();
});

function verdict(plane: BrowserInferencePlane): BrowserInferenceVerdict {
  return {
    plane,
    limit: plane === "builtin" ? null : "needs-download",
    report: {
      secureContext: true,
      builtinPresent: plane !== "none",
      text: "available",
      vision: plane === "builtin" ? "available" : "unavailable",
      webgpu: plane === "webgpu-download",
    },
  };
}

const OLLAMA: ModelProviderRecord = {
  kind: "local",
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "qwen2.5-vl:7b",
};

describe("resolveModelPlane", () => {
  it("uses a configured provider even where the browser could carry it", () => {
    // An operator who typed an endpoint is not second-guessed by a probe.
    const plane = resolveModelPlane(OLLAMA, verdict("builtin"));
    expect(plane.kind).toBe("local");
    expect(plane.because).toBe("configured");
  });

  it("falls back to the browser when no provider was named", () => {
    const plane = resolveModelPlane(NO_MODEL_PROVIDER, verdict("builtin"));
    expect(plane.kind).toBe("browser");
    expect(plane.because).toBe("fell-back-to-browser");
    expect(autonomousResetAvailable(plane)).toBe(true);
  });

  it("never turns a skip into a download", () => {
    for (const plane of ["builtin-download", "webgpu-download"] as const) {
      const resolved = resolveModelPlane(NO_MODEL_PROVIDER, verdict(plane));
      expect(resolved.kind).toBe("none");
      expect(resolved.because).toBe("browser-not-ready");
      expect(resolved.browserPlane).toBe(plane);
      expect(autonomousResetAvailable(resolved)).toBe(false);
    }
  });

  it("leaves the ceremony off where the device can carry nothing", () => {
    const plane = resolveModelPlane(NO_MODEL_PROVIDER, verdict("none"));
    expect(plane.kind).toBe("none");
    expect(plane.because).toBe("no-plane");
    expect(autonomousResetAvailable(plane)).toBe(false);
  });

  it("holds a chosen browser plane off until it is actually ready", () => {
    const chosen: ModelProviderRecord = {
      kind: "browser",
      provider: "browser",
      endpoint: "",
      model: "",
    };
    expect(resolveModelPlane(chosen, verdict("builtin")).kind).toBe("browser");

    const notYet = resolveModelPlane(chosen, verdict("builtin-download"));
    expect(notYet.kind).toBe("none");
    expect(notYet.because).toBe("browser-not-ready");
  });

  it("keeps a hosted provider hosted", () => {
    const hosted: ModelProviderRecord = {
      kind: "hosted",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-5",
    };
    expect(resolveModelPlane(hosted, verdict("builtin")).kind).toBe("hosted");
  });
});

describe("the stored record", () => {
  it("round-trips an arrangement", async () => {
    await saveModelProvider(OLLAMA);
    expect(loadModelProvider()).toEqual(OLLAMA);
  });

  it("reads a missing record as no provider", () => {
    expect(loadModelProvider()).toEqual(NO_MODEL_PROVIDER);
  });

  it("fails closed on a corrupt record rather than half-parsing an address", async () => {
    await kvSetDurable(MODEL_PROVIDER_KEY, "{not json");
    expect(loadModelProvider()).toEqual(NO_MODEL_PROVIDER);

    await kvSetDurable(MODEL_PROVIDER_KEY, '"a string"');
    expect(loadModelProvider()).toEqual(NO_MODEL_PROVIDER);
  });

  it("reads an unknown kind as no provider", async () => {
    await kvSetDurable(
      MODEL_PROVIDER_KEY,
      JSON.stringify({ kind: "satellite", endpoint: "https://elsewhere" }),
    );
    expect(loadModelProvider()).toEqual(NO_MODEL_PROVIDER);
  });

  it("drops an endpoint smuggled onto the browser plane", async () => {
    // The browser plane has no address by construction; carrying one would
    // let a stored record aim in-page inference at a remote host.
    await kvSetDurable(
      MODEL_PROVIDER_KEY,
      JSON.stringify({
        kind: "browser",
        provider: "browser",
        endpoint: "https://exfil.example",
        model: "",
      }),
    );
    expect(loadModelProvider().endpoint).toBe("");
  });

  it("stores no field a key could be smuggled into", async () => {
    await saveModelProvider({
      kind: "hosted",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-5",
    });
    const raw = kvGet(MODEL_PROVIDER_KEY) ?? "";
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "endpoint",
      "kind",
      "model",
      "provider",
    ]);
  });
});
