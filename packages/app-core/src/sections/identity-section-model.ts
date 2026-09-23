import { ByoError } from "../lib/byo.js";
/**
 * View-model logic for `IdentitySection` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import { DirectoryError } from "../lib/directory.js";
import type { IdpRecord } from "../lib/idp-registry.js";

export function identityErrorText<Thrown>(error: Thrown): string {
  if (error instanceof DirectoryError) return error.message;
  if (error instanceof ByoError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export const PRINCIPAL_STATE_CHIP = new Map([
  ["provisional", { label: "Guest", tone: "chip--warn" }],
  ["active", { label: "active", tone: "chip--ok" }],
  ["suspended", { label: "suspended", tone: "chip--err" }],
  ["closed", { label: "closed", tone: "" }],
]);

export function stateChip(state: string): { label: string; tone: string } {
  return PRINCIPAL_STATE_CHIP.get(state) ?? { label: state, tone: "" };
}

/** Principal ids are opaque and long; show enough to recognise, copy the rest. */
export function truncateId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 14)}…${id.slice(-4)}` : id;
}

export function providerChipLabel(
  device: boolean,
  kind: IdpRecord["kind"],
  presetLabel: string | undefined,
): string {
  if (device) return "This device";
  if (kind === "first-class") return "First-class";
  return presetLabel ?? "Custom OIDC";
}

export function countdown(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return "expired";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  if (seconds < 60) return rtf.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
