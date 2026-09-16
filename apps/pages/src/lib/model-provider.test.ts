import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserInferencePlane,
  BrowserInferenceVerdict,
} from "./browser-inference.js";
import { kvGet, kvSetDurable } from "./kv.js";
import {
  DEFAULT_VOICE_CHOICE,
  MODEL_PROVIDER_KEY,
  type ModelProviderRecord,
  NO_MODEL_PROVIDER,
  aiModelChoiceKeys,
  autonomousResetAvailable,
  browserInferenceForCommands,
  loadModelProvider,
  modelProviderSeams,
  resolveModelPlane,
  saveModelProvider,
  voiceRecognitionLang,
  withInference,
  withVoice,
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

function withRoles(
  partial: Omit<ModelProviderRecord, "voice" | "inference">,
): ModelProviderRecord {
  return {
    ...partial,
    voice: DEFAULT_VOICE_CHOICE,
    inference: {
      kind: partial.kind,
      provider: partial.provider,
      endpoint: partial.endpoint,
      model: partial.model,
    },
  };
}

const OLLAMA = withRoles({
  kind: "local",
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  model: "qwen2.5-vl:7b",
});

describe("resolveModelPlane", () => {
  it("uses a configured provider even where the browser could carry it", () => {
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
    const chosen = withRoles({
      kind: "browser",
      provider: "browser",
      endpoint: "",
      model: "",
    });
    expect(resolveModelPlane(chosen, verdict("builtin")).kind).toBe("browser");

    const notYet = resolveModelPlane(chosen, verdict("builtin-download"));
    expect(notYet.kind).toBe("none");
    expect(notYet.because).toBe("browser-not-ready");
  });

  it("keeps a hosted provider hosted", () => {
    const hosted = withRoles({
      kind: "hosted",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-5",
    });
    expect(resolveModelPlane(hosted, verdict("builtin")).kind).toBe("hosted");
  });
});

describe("voice and inference roles", () => {
  it("defaults voice to browser speech when nothing was stored", () => {
    expect(loadModelProvider().voice).toEqual(DEFAULT_VOICE_CHOICE);
    expect(voiceRecognitionLang()).toBe("en-US");
  });

  it("migrates a legacy top-level-only record into inference", async () => {
    await kvSetDurable(
      MODEL_PROVIDER_KEY,
      JSON.stringify({
        kind: "local",
        provider: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "llava",
      }),
    );
    const loaded = loadModelProvider();
    expect(loaded.inference).toEqual({
      kind: "local",
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "llava",
    });
    expect(loaded.voice).toEqual(DEFAULT_VOICE_CHOICE);
  });

  it("persists a speech language pick without changing inference", async () => {
    await saveModelProvider(OLLAMA);
    const next = withVoice(OLLAMA, {
      provider: "browser-speech",
      kind: "browser",
      endpoint: "",
      model: "fr-FR",
    });
    await saveModelProvider(next);
    const loaded = loadModelProvider();
    expect(loaded.voice.model).toBe("fr-FR");
    expect(loaded.inference.provider).toBe("ollama");
    expect(voiceRecognitionLang(loaded)).toBe("fr-FR");
  });

  it("syncs top-level fields when inference changes", () => {
    const next = withInference(NO_MODEL_PROVIDER, {
      kind: "browser",
      provider: "browser",
      endpoint: "https://should-drop.example",
      model: "",
    });
    expect(next.kind).toBe("browser");
    expect(next.provider).toBe("browser");
    expect(next.endpoint).toBe("");
    expect(next.inference.endpoint).toBe("");
  });

  it("withholds Prompt API freer phrasing when inference is local", () => {
    expect(browserInferenceForCommands(OLLAMA)).toBe(false);
    expect(browserInferenceForCommands(NO_MODEL_PROVIDER)).toBe(true);
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
    await saveModelProvider(
      withRoles({
        kind: "hosted",
        provider: "anthropic",
        endpoint: "https://api.anthropic.com",
        model: "claude-sonnet-5",
      }),
    );
    const raw = kvGet(MODEL_PROVIDER_KEY) ?? "";
    const parsed: { voice: object; inference: object } = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual([
      "endpoint",
      "inference",
      "kind",
      "model",
      "provider",
      "voice",
    ]);
    expect(Object.keys(parsed.voice).sort()).toEqual(
      [...aiModelChoiceKeys()].sort(),
    );
    expect(Object.keys(parsed.inference).sort()).toEqual(
      [...aiModelChoiceKeys()].sort(),
    );
  });
});

/** The smallest OPFS a save and a hydrate need. */
function fakeOpfsRoot() {
  const files = new Map<string, string>();
  return {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!opts?.create) {
          throw new DOMException("not found", "NotFoundError");
        }
        files.set(name, "");
      }
      return {
        async getFile() {
          return {
            async text() {
              return files.get(name) ?? "";
            },
          };
        },
        async createWritable() {
          return {
            async write(value: string) {
              files.set(name, value);
            },
            async close() {},
          };
        },
      };
    },
  };
}

describe("surviving a reload", () => {
  it("loads what was saved once boot hydrates the key", async () => {
    const fakeRoot = fakeOpfsRoot();
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => fakeRoot },
    });
    const record = withRoles({
      kind: "local",
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "llava",
    });
    try {
      await saveModelProvider(record);
      vi.resetModules();
      const freshKv = await import("./kv.js");
      await freshKv.kvHydrate([MODEL_PROVIDER_KEY]);
      const fresh = await import("./model-provider.js");
      expect(fresh.loadModelProvider()).toEqual(record);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
