/**
 * Provider/model slug options for Settings › Connections › Models.
 *
 * Agent Harnesses configure the hosted providers; this module only lists
 * selectable slugs. Local loopback and the browser Prompt API stay available
 * without a harness (they need no sealed key).
 */

import { listConnections } from "./connections.js";
import { hostedModelAuthority } from "./hosted-model-authority.js";
import {
  BROWSER_INFERENCE_ENTRY,
  INFERENCE_MODEL_CATALOG,
  type ModelCatalogEntry,
  VOICE_MODEL_CATALOG,
  catalogEntry,
} from "./model-catalog.js";
import type { AiModelChoice } from "./model-provider.js";

/** `provider/model` — model may be empty (`browser/`). */
export type ModelSlug = string;

export type ModelSlugOption = {
  readonly value: ModelSlug;
  readonly label: string;
  readonly choice: AiModelChoice;
};

const HARNESS_PROVIDER_IDS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "azure-openai",
  "aws-bedrock",
  "openrouter",
  "huggingface",
]);

const NONE_INFERENCE: AiModelChoice = {
  provider: "",
  kind: "none",
  endpoint: "",
  model: "",
};

export const modelSlugSeams = {
  listConnections,
};

export function encodeModelSlug(provider: string, model: string): ModelSlug {
  return `${provider}/${model}`;
}

export function choiceToSlug(choice: AiModelChoice): ModelSlug {
  if (!choice.provider) return "";
  return encodeModelSlug(choice.provider, choice.model);
}

export function choiceFromSlug(
  slug: ModelSlug,
  options: readonly ModelSlugOption[],
): AiModelChoice | null {
  if (slug === "") return NONE_INFERENCE;
  const hit = options.find((option) => option.value === slug);
  return hit?.choice ?? null;
}

function optionFromEntry(
  entry: ModelCatalogEntry,
  model: string,
): ModelSlugOption {
  const value = encodeModelSlug(entry.id, model);
  const label = model ? `${entry.name} · ${model}` : entry.name;
  return {
    value,
    label,
    choice: {
      provider: entry.id,
      kind: entry.kind,
      endpoint: entry.endpoint,
      model,
    },
  };
}

function expandEntry(entry: ModelCatalogEntry): ModelSlugOption[] {
  const models =
    entry.models.length > 0 ? entry.models : entry.model ? [entry.model] : [""];
  return models.map((model) => optionFromEntry(entry, model));
}

/** Voice: browser speech languages when recognition exists. */
export function voiceSlugOptions(speechReady: boolean): ModelSlugOption[] {
  if (!speechReady) return [];
  const entry = VOICE_MODEL_CATALOG[0];
  if (!entry) return [];
  return expandEntry(entry);
}

/**
 * Inference: none, browser (when ready), local loopback always, then every
 * Agent Harness provider that already has an active connection.
 */
export function inferenceSlugOptions(args: {
  readonly browserReady: boolean;
  readonly connectedProviderIds: readonly string[];
}): ModelSlugOption[] {
  const options: ModelSlugOption[] = [
    {
      value: "",
      label: "None",
      choice: NONE_INFERENCE,
    },
  ];
  if (args.browserReady) {
    options.push(...expandEntry(BROWSER_INFERENCE_ENTRY));
  }
  for (const entry of INFERENCE_MODEL_CATALOG) {
    if (entry.kind === "local") {
      options.push(...expandEntry(entry));
      continue;
    }
    if (!HARNESS_PROVIDER_IDS.has(entry.id)) continue;
    if (!args.connectedProviderIds.includes(entry.id)) continue;
    options.push(...expandEntry(entry));
  }
  for (const providerId of args.connectedProviderIds) {
    if (!HARNESS_PROVIDER_IDS.has(providerId)) continue;
    if (options.some((option) => option.choice.provider === providerId)) {
      continue;
    }
    const known = catalogEntry(INFERENCE_MODEL_CATALOG, providerId);
    if (known) {
      options.push(...expandEntry(known));
      continue;
    }
    options.push(
      optionFromEntry(
        {
          id: providerId,
          kind: "hosted",
          name: providerId,
          kindLabel: "connected",
          endpoint: "",
          model: "",
          models: [],
        },
        "",
      ),
    );
  }
  return options;
}

/** Active Agent Harness provider ids, or [] when the directory is unreachable. */
export async function connectedHarnessProviderIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const row of hostedModelAuthority()?.connections() ?? []) {
    if (HARNESS_PROVIDER_IDS.has(row.providerId) && row.status === "connected")
      ids.add(row.providerId);
  }
  try {
    const rows = await modelSlugSeams.listConnections();
    for (const row of rows) {
      if (row.status === "active" && HARNESS_PROVIDER_IDS.has(row.providerId))
        ids.add(row.providerId);
    }
  } catch {
    /* Native device connections remain available offline. */
  }
  return [...ids];
}
