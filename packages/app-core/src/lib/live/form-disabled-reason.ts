/**
 * Why a live-session form commit is still disabled — for `title` / `aria-label`
 * on the `.go` square, not an in-page caption (ADR 0163).
 */

import type { LiveLink } from "./link.js";

export function liveJoinAskDisabledReason(input: {
  link: LiveLink | null;
  pasted: string;
  needsCode: boolean;
  code: string;
  name: string;
  busy: boolean;
}): string | undefined {
  if (input.busy) return undefined;
  if (!input.link) {
    return input.pasted.trim()
      ? "Paste a live-session link that parses"
      : "Paste a live-session link";
  }
  if (!input.name.trim()) return "Enter your name";
  if (input.needsCode && input.code.trim() === "")
    return "Enter the invite code";
  return undefined;
}

export function liveHostStartDisabledReason(input: {
  loaded: boolean;
  refused: string | null;
  starting: boolean;
  title: string;
  scope: "vault" | "items";
  chosenCount: number;
}): string | undefined {
  if (input.starting) return undefined;
  if (!input.loaded) return "Loading routes for this vault";
  if (input.refused) return input.refused;
  if (!input.title.trim()) return "Name the session";
  if (input.scope === "items" && input.chosenCount === 0) {
    return "Choose at least one item";
  }
  return undefined;
}
