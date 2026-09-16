/**
 * Interpret a command-bar utterance: deterministic parse first, then AI SDK
 * `generateObject` against the browser Prompt API when the inference pick
 * allows it.
 */

import { detectLocalLanguageModel } from "../../tutorial/agents/prompt-api/detect.js";
import {
  browserInferenceForCommands,
  loadModelProvider,
} from "../model-provider.js";
import { parseCommand } from "./parse.js";
import { createPromptLanguageModel } from "./prompt-model.js";
import { type AppCommand, appCommandSchema } from "./types.js";

type GenerateObject = typeof import("ai").generateObject;

type InterpretSeams = {
  generateObject: GenerateObject | null;
  loadModelProvider: typeof loadModelProvider;
};

/** Injected for tests; production loads `ai` only when the model path runs. */
export const interpretSeams: InterpretSeams = {
  generateObject: null,
  loadModelProvider,
};

async function generateObjectFn(): Promise<GenerateObject> {
  if (interpretSeams.generateObject !== null) {
    return interpretSeams.generateObject;
  }
  const mod = await import("ai");
  return mod.generateObject;
}

export type InterpretResult =
  | { source: "parse" | "model"; command: AppCommand }
  | { source: "none"; reason: string };

/** Names only — never passwords, TOTP seeds, or notes. */
export function itemNameCatalog(names: readonly string[]): string {
  if (names.length === 0) return "(vault empty or locked)";
  return names.slice(0, 80).join(", ");
}

export async function interpretCommand(
  utterance: string,
  options?: { itemNames?: readonly string[] },
): Promise<InterpretResult> {
  const trimmed = utterance.trim();
  if (trimmed === "") {
    return { source: "none", reason: "Empty command." };
  }

  const parsed = parseCommand(trimmed);
  if (parsed !== null) {
    return { source: "parse", command: parsed };
  }

  const record = interpretSeams.loadModelProvider();
  if (!browserInferenceForCommands(record)) {
    return {
      source: "none",
      reason:
        "No match. Try “copy password for …” or “go to vault”. Freer phrasing uses this device's own model — pick it under Settings › AI models.",
    };
  }

  const api = detectLocalLanguageModel();
  if (api === null) {
    return {
      source: "none",
      reason:
        "No match. Try “copy password for …” or “go to vault”. On-device model unavailable.",
    };
  }
  const availability = await api.availability();
  if (availability !== "available") {
    return {
      source: "none",
      reason:
        availability === "downloadable"
          ? "No exact match. Download the on-device model from Support to interpret freer phrasing."
          : "No exact match, and the on-device model is not ready.",
    };
  }

  try {
    const catalog = itemNameCatalog(options?.itemNames ?? []);
    const generateObject = await generateObjectFn();
    const { object } = await generateObject({
      model: createPromptLanguageModel({ api }),
      schema: appCommandSchema,
      prompt: [
        "Map this operator request to one command object.",
        "Prefer copy_field when they ask for a password, username, code, or url.",
        "query is a vault item name fragment from this catalog:",
        catalog,
        "",
        `Request: ${trimmed}`,
      ].join("\n"),
    });
    return { source: "model", command: object };
  } catch {
    return {
      source: "none",
      reason: "Could not interpret that. Try a shorter command.",
    };
  }
}
