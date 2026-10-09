/**
 * Why a live-session form commit is still disabled — for `title` / `aria-label`
 * on the `.go` square, not an in-page caption (ADR 0163).
 */

import { normalizeInviteCode } from "../join/invite.js";
import type { LiveLink } from "./link.js";
import { cleanText } from "./messages.js";

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
  if (!cleanText(input.name).length) return "Name is required";
  if (input.needsCode) {
    if (input.code.trim() === "") return "Enter the invite code";
    if (normalizeInviteCode(input.code) === null) {
      return "Enter the invite code, eight letters";
    }
  }
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
