/**
 * What the "create a key" sheet offers and how it reads what was typed
 * (ADR 0190 §6). Pure, so the choices a person sees and the draft they approve
 * are tested apart from the screen.
 *
 * The choices are few on purpose. A budget is one of three named sizes and a
 * lifetime one of two, because a person deciding what to hand an agent is
 * deciding how much it may spend and for how long, not tuning four numbers;
 * the broker still holds every number to the same ceilings whatever the sheet
 * offers.
 */
import { isModelEntry } from "./details.js";
import type { MintChoice } from "./mint.js";
import type { KeyView } from "./types.js";
import { LIMITS } from "./vocabulary.js";

export type BudgetPreset = Readonly<{
  id: "small" | "medium" | "large";
  label: string;
  budget: MintChoice["budget"];
}>;

export const BUDGET_PRESETS: readonly BudgetPreset[] = [
  {
    id: "small",
    label: "Small",
    budget: {
      requests: 25,
      input_tokens: 25_000,
      output_tokens: 12_500,
      max_output_tokens: 1024,
    },
  },
  {
    id: "medium",
    label: "Medium",
    budget: {
      requests: 200,
      input_tokens: 200_000,
      output_tokens: 100_000,
      max_output_tokens: 4096,
    },
  },
  {
    id: "large",
    label: "Large",
    budget: {
      requests: 1000,
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      max_output_tokens: 8192,
    },
  },
];

export const KEY_LIFETIMES: readonly { seconds: number; label: string }[] = [
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 8 * 60 * 60, label: "8 hours" },
];

const CLIENT = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** The app or agent's name, trimmed, or `null` when it cannot name one. */
export function parseClientName(text: string): string | null {
  const name = text.trim();
  return CLIENT.test(name) ? name : null;
}

/**
 * Models as typed: separated by commas, spaces or lines, each a model id,
 * `namespace/*` or `*`. `null` when nothing was typed or one entry is not a
 * model — a typo is a refusal, never a quietly smaller list.
 */
export function parseModelList(text: string): string[] | null {
  const entries = text.split(/[\s,]+/).filter((entry) => entry !== "");
  if (entries.length === 0 || entries.length > LIMITS.maxModelsPerKey)
    return null;
  const out: string[] = [];
  for (const entry of entries) {
    if (!isModelEntry(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** The names a key's selectors stand for: `model:openai/gpt-4o` → `gpt-4o`. */
export function modelNames(view: Pick<KeyView, "models" | "providerId">) {
  const head = `model:${view.providerId}/`;
  return view.models.map((selector) =>
    selector.startsWith(head) ? selector.slice(head.length) : selector,
  );
}

const MINUTE = 60_000;

/** How long a key has left, in the largest whole unit: `42 min`, `3 h`. */
export function timeLeft(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "ended";
  if (left < MINUTE) return "under a minute";
  if (left < 60 * MINUTE) return `${Math.floor(left / MINUTE)} min`;
  return `${Math.floor(left / (60 * MINUTE))} h`;
}

/** The whole of a key's remaining requests against what it began with, for the list. */
export function requestsLeft(view: Pick<KeyView, "remaining">): string {
  return `${view.remaining.requests.toLocaleString("en-US")} requests left`;
}
