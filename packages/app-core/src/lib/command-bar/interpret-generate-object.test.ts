import type { LanguageModelV2 } from "@ai-sdk/provider";
import {
  NoObjectGeneratedError,
  generateObject as sdkGenerateObject,
} from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  LocalLanguageModelApi,
  LocalModelCreateOptions,
  LocalModelSession,
} from "../../tutorial/agents/prompt-api/detect.js";
import { generateObject } from "./interpret-generate-object.js";
import { createPromptLanguageModel } from "./prompt-model.js";
import { appCommandSchema } from "./schema.js";

const generators = [sdkGenerateObject, generateObject];
const strictHelp = z.strictObject({ action: z.literal("help") });
const unexpectedFetch = vi.fn(async () => {
  throw new Error("The browser Prompt API must not fetch a remote model");
});

function promptFixture(reply: LocalModelSession["prompt"]) {
  const prompts: string[] = [];
  const signals: AbortSignal[] = [];
  const created: LocalModelCreateOptions[] = [];
  const api: LocalLanguageModelApi = {
    availability: async () => "available",
    create: async (options) => {
      created.push(options);
      return {
        prompt: async (input, options) => {
          prompts.push(input);
          signals.push(options.signal);
          return reply(input, options);
        },
        destroy() {},
      };
    },
  };
  return {
    model: createPromptLanguageModel({ api }),
    prompts,
    signals,
    created,
  };
}

async function rejection<Result>(promise: Promise<Result>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw cause;
  }
  throw new Error("Expected the model request to fail");
}

beforeEach(() => {
  unexpectedFetch.mockClear();
  vi.stubGlobal("fetch", unexpectedFetch);
});

afterEach(() => {
  try {
    expect(unexpectedFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("explicit browser model facade", () => {
  it("keeps the official SDK result and actual Prompt API adapter behavior", async () => {
    for (const generate of generators) {
      const fixture = promptFixture(async () => '{"action":"help"}');
      const result = await generate({
        model: fixture.model,
        schema: appCommandSchema,
        prompt: "Show command help",
        maxRetries: 0,
      });
      expect(result.object).toEqual({ action: "help" });
      expect(fixture.prompts).toHaveLength(1);
      expect(fixture.prompts[0]).toContain("Show command help");
      expect(fixture.created[0]?.initialPrompts).toEqual([
        {
          role: "system",
          content:
            "You map short operator requests to a single JSON command. Never invent secrets. Reply with JSON only.",
        },
      ]);
    }
  });

  it("preserves the original model identity and SDK property-read behavior", async () => {
    const accessTraces: string[][] = [];
    for (const generate of generators) {
      const fixture = promptFixture(async () => '{"action":"help"}');
      const reads: string[] = [];
      const model: LanguageModelV2 = {
        ...fixture.model,
        get specificationVersion() {
          reads.push("specificationVersion");
          return fixture.model.specificationVersion;
        },
        get provider() {
          reads.push("provider");
          return fixture.model.provider;
        },
        get modelId() {
          reads.push("modelId");
          return fixture.model.modelId;
        },
        doGenerate(call) {
          expect(this).toBe(model);
          return fixture.model.doGenerate(call);
        },
      };
      Object.defineProperty(model, "notForInspection", {
        enumerable: true,
        get() {
          throw new Error("Unrelated model fields must not be inspected");
        },
      });
      const result = await generate({
        model,
        schema: appCommandSchema,
        prompt: "Show command help",
        maxRetries: 0,
      });
      expect(result.object).toEqual({ action: "help" });
      accessTraces.push(reads);
    }
    expect(accessTraces[1]).toEqual(accessTraces[0]);
  });

  it.each([
    '{"action":"unknown"}',
    '{"action":"help","unexpected":"forbidden"}',
    "not JSON",
  ])(
    "retains official strict-schema and JSON refusal for %s",
    async (reply) => {
      const errors: Error[] = [];
      for (const generate of generators) {
        const fixture = promptFixture(async () => reply);
        const error = await rejection(
          generate({
            model: fixture.model,
            schema: strictHelp,
            prompt: "Return command help",
            maxRetries: 0,
          }),
        );
        expect(error).toBeInstanceOf(NoObjectGeneratedError);
        expect(fixture.prompts).toHaveLength(1);
        errors.push(error);
      }
      expect(errors[1]?.name).toBe(errors[0]?.name);
      expect(errors[1]?.message).toBe(errors[0]?.message);
    },
  );

  it("preserves a provider error's identity without a fallback request", async () => {
    const failure = new Error("Local Prompt API fixture failed");
    for (const generate of generators) {
      const fixture = promptFixture(async () => {
        throw failure;
      });
      await expect(
        generate({
          model: fixture.model,
          schema: strictHelp,
          prompt: "Return command help",
          maxRetries: 0,
        }),
      ).rejects.toBe(failure);
      expect(fixture.prompts).toHaveLength(1);
    }
  });

  it("preserves an already-aborted signal at the native Prompt session", async () => {
    for (const generate of generators) {
      const fixture = promptFixture(async (_input, { signal }) => {
        signal.throwIfAborted();
        return '{"action":"help"}';
      });
      const controller = new AbortController();
      const reason = new DOMException("Fixture was cancelled", "AbortError");
      controller.abort(reason);
      await expect(
        generate({
          model: fixture.model,
          schema: strictHelp,
          prompt: "Return command help",
          abortSignal: controller.signal,
          maxRetries: 0,
        }),
      ).rejects.toBe(reason);
      expect(fixture.prompts).toHaveLength(1);
      expect(fixture.signals[0]?.aborted).toBe(true);
      expect(fixture.signals[0]?.reason).toBe(reason);
    }
  });

  it("forwards in-flight cancellation to the actual Prompt API session", async () => {
    for (const generate of generators) {
      let markStarted = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const fixture = promptFixture(
        (_input, { signal }) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            markStarted();
          }),
      );
      const controller = new AbortController();
      const pending = generate({
        model: fixture.model,
        schema: strictHelp,
        prompt: "Return command help",
        abortSignal: controller.signal,
        maxRetries: 0,
      });
      await started;
      const reason = new DOMException("Fixture was cancelled", "AbortError");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(fixture.signals[0]?.aborted).toBe(true);
      expect(fixture.signals[0]?.reason).toBe(reason);
    }
  });

  it("refuses string models before consulting a configured global provider", async () => {
    const languageModel = vi.fn(() => {
      throw new Error("The global provider must never be consulted");
    });
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", { languageModel });
    await expect(
      generateObject({
        model: "remote/default-model",
        schema: strictHelp,
        prompt: "Return command help",
        maxRetries: 0,
      }),
    ).rejects.toThrow("An explicit browser language-model object is required.");
    expect(languageModel).not.toHaveBeenCalled();
  });

  it("refuses string models when no global provider is configured", async () => {
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", undefined);
    await expect(
      generateObject({
        model: "remote/default-model",
        schema: strictHelp,
        prompt: "Return command help",
        maxRetries: 0,
      }),
    ).rejects.toThrow("An explicit browser language-model object is required.");
  });
});
