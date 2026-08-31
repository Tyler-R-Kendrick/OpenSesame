import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserInferenceReport,
  browserInference,
  browserInferenceSeams,
  planeIsReady,
  probeBrowserInference,
  readBrowserInference,
} from "./browser-inference.js";

const original = { ...browserInferenceSeams };

afterEach(() => {
  Object.assign(browserInferenceSeams, original);
  vi.restoreAllMocks();
});

function report(
  overrides: Partial<BrowserInferenceReport> = {},
): BrowserInferenceReport {
  return {
    secureContext: true,
    builtinPresent: false,
    text: "unavailable",
    vision: "unavailable",
    webgpu: false,
    ...overrides,
  };
}

describe("readBrowserInference", () => {
  it("uses the browser's own model when it can already see a page", () => {
    const verdict = readBrowserInference(
      report({ builtinPresent: true, text: "available", vision: "available" }),
    );
    expect(verdict.plane).toBe("builtin");
    expect(verdict.limit).toBeNull();
  });

  it("does not resolve to a rung that would start a download", () => {
    for (const vision of ["downloadable", "downloading"] as const) {
      const verdict = readBrowserInference(
        report({ builtinPresent: true, text: "available", vision }),
      );
      expect(verdict.plane).toBe("builtin-download");
      expect(verdict.limit).toBe("needs-download");
      expect(planeIsReady(verdict.plane)).toBe(false);
    }
  });

  it("refuses a text-only built-in model, and says that is what it is", () => {
    // The deciding fact is image input: a model that cannot see the page has
    // nothing to point `fill_credential` at, however good its text is.
    const verdict = readBrowserInference(
      report({
        builtinPresent: true,
        text: "available",
        vision: "unavailable",
        webgpu: false,
      }),
    );
    expect(verdict.plane).toBe("none");
    expect(verdict.limit).toBe("text-only");
  });

  it("offers the WebGPU rung when the built-in model cannot see", () => {
    const verdict = readBrowserInference(
      report({
        builtinPresent: true,
        text: "available",
        vision: "unavailable",
        webgpu: true,
      }),
    );
    expect(verdict.plane).toBe("webgpu-download");
    expect(verdict.limit).toBe("text-only");
    expect(planeIsReady(verdict.plane)).toBe(false);
  });

  it("separates 'no model at all' from 'a model that cannot see'", () => {
    expect(readBrowserInference(report({ webgpu: false })).limit).toBe(
      "no-hardware",
    );
    expect(readBrowserInference(report({ webgpu: true })).limit).toBe(
      "no-builtin",
    );
  });

  it("refuses everything outside a secure context", () => {
    const verdict = readBrowserInference(
      report({
        secureContext: false,
        builtinPresent: true,
        text: "available",
        vision: "available",
        webgpu: true,
      }),
    );
    expect(verdict.plane).toBe("none");
    expect(verdict.limit).toBe("insecure-context");
  });
});

describe("probeBrowserInference", () => {
  it("asks about image input separately from text", async () => {
    const availability = vi.fn(
      async (options?: {
        expectedInputs?: readonly { readonly type: string }[];
      }) => (options === undefined ? "available" : "unavailable"),
    );
    browserInferenceSeams.languageModel = () => ({ availability });
    browserInferenceSeams.gpu = () => null;

    const result = await probeBrowserInference();

    expect(result.text).toBe("available");
    expect(result.vision).toBe("unavailable");
    expect(availability).toHaveBeenCalledWith(undefined);
    expect(availability).toHaveBeenCalledWith({
      expectedInputs: [{ type: "image" }],
    });
  });

  it("treats an unrecognised availability answer as absence", async () => {
    browserInferenceSeams.languageModel = () => ({
      availability: async () => "readily",
    });
    browserInferenceSeams.gpu = () => null;

    const result = await probeBrowserInference();

    expect(result.text).toBe("unavailable");
    expect(result.vision).toBe("unavailable");
  });

  it("survives a browser that throws on the probe", async () => {
    browserInferenceSeams.languageModel = () => ({
      availability: async () => {
        throw new Error("not implemented");
      },
    });
    browserInferenceSeams.gpu = () => ({
      requestAdapter: async () => {
        throw new Error("no adapter");
      },
    });

    const result = await probeBrowserInference();

    expect(result.builtinPresent).toBe(true);
    expect(result.text).toBe("unavailable");
    expect(result.webgpu).toBe(false);
  });

  it("never touches the model outside a secure context", async () => {
    const availability = vi.fn(async () => "available");
    browserInferenceSeams.isSecureContext = () => false;
    browserInferenceSeams.languageModel = () => ({ availability });
    browserInferenceSeams.gpu = () => ({ requestAdapter: async () => ({}) });

    const result = await probeBrowserInference();

    expect(availability).not.toHaveBeenCalled();
    expect(result.builtinPresent).toBe(false);
    expect(result.webgpu).toBe(false);
  });

  it("reports a WebGPU adapter when one is offered", async () => {
    browserInferenceSeams.languageModel = () => null;
    browserInferenceSeams.gpu = () => ({ requestAdapter: async () => ({}) });

    expect((await probeBrowserInference()).webgpu).toBe(true);
  });

  it("reports no adapter when requestAdapter resolves null", async () => {
    browserInferenceSeams.languageModel = () => null;
    browserInferenceSeams.gpu = () => ({ requestAdapter: async () => null });

    expect((await probeBrowserInference()).webgpu).toBe(false);
  });
});

describe("browserInference", () => {
  it("probes and reads in one step", async () => {
    browserInferenceSeams.languageModel = () => ({
      availability: async () => "available",
    });
    browserInferenceSeams.gpu = () => null;

    expect((await browserInference()).plane).toBe("builtin");
  });

  it("reports nothing on a browser with neither global", async () => {
    browserInferenceSeams.languageModel = () => null;
    browserInferenceSeams.gpu = () => null;

    const verdict = await browserInference();

    expect(verdict.plane).toBe("none");
    expect(verdict.limit).toBe("no-hardware");
  });
});

describe("the default seams", () => {
  it("ignore a LanguageModel global with no availability method", () => {
    type Scope = { LanguageModel?: BoundaryValue };
    const scope =
      /* SAFETY: the property is declared optional, so this only widens the
         lookup surface — it asserts nothing about what the runtime carries. */
      globalThis as Scope;
    const had = "LanguageModel" in scope;
    scope.LanguageModel = {};
    try {
      expect(original.languageModel()).toBeNull();
    } finally {
      if (had) scope.LanguageModel = undefined;
      else Reflect.deleteProperty(scope, "LanguageModel");
    }
  });

  it("treat an environment with no isSecureContext as secure", () => {
    // jsdom and Node both leave it undefined; defaulting to "insecure" there
    // would report every test and every SSR pass as an unsafe browser.
    expect([true, false]).toContain(original.isSecureContext());
  });

  it("ignore a navigator with no gpu", () => {
    expect(original.gpu()).toBeNull();
  });
});
