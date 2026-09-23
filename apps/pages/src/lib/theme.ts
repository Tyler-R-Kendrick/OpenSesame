/**
 * Device appearance — day / night / system.
 *
 * Theme is not a secret: it has to apply on the unlock screen and survive a
 * reload while the vault is locked. Callers that hold an unlocked vault mirror
 * the choice into sealed prefs so Settings → Appearance stays consistent.
 */

import { kvGet, kvSet } from "@opensesame/app-core/lib/kv.js";
import { useSyncExternalStore } from "react";

export const THEME_KEY = "appearance.theme.v1";

export type ThemeId = "system" | "light" | "dark";

const THEME_IDS = ["system", "light", "dark"] as const;

const listeners = new Set<() => void>();

let cached: ThemeId | null = null;

function isThemeId(value: string): value is ThemeId {
  // SAFETY: test/fixture or boundary-checked value matches readonly string[]).includes(value).
  return (THEME_IDS as readonly string[]).includes(value);
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Paint `data-theme` on the document (or clear it for system). */
export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function loadTheme(): ThemeId {
  if (cached) return cached;
  const raw = kvGet(THEME_KEY)?.trim() ?? "";
  cached = isThemeId(raw) ? raw : "system";
  return cached;
}

/** True when OPFS/memory already holds an explicit theme choice. */
export function hasStoredTheme(): boolean {
  const raw = kvGet(THEME_KEY)?.trim() ?? "";
  return isThemeId(raw);
}

/** Persist and apply a theme on the device (plaintext kv). */
export function setTheme(theme: ThemeId): void {
  cached = theme;
  kvSet(THEME_KEY, theme);
  applyTheme(theme);
  emit();
}

/** Cycle Day → Night → System → Day. */
export function cycleTheme(current: ThemeId = loadTheme()): ThemeId {
  const order: ThemeId[] = ["light", "dark", "system"];
  const index = order.indexOf(current);
  const next = order[(index + 1) % order.length] ?? "light";
  setTheme(next);
  return next;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hook for chrome controls. */
export function useThemePreference(): ThemeId {
  return useSyncExternalStore(subscribeTheme, loadTheme, () => "system");
}

export function themeLabel(theme: ThemeId): string {
  if (theme === "light") return "Day";
  if (theme === "dark") return "Night";
  return "System";
}

/** Next label when cycling from `theme`. */
export function nextThemeLabel(theme: ThemeId): string {
  if (theme === "light") return "Night";
  if (theme === "dark") return "System";
  return "Day";
}

/**
 * After OPFS hydrate: apply the stored theme before first paint.
 * Call once from boot.
 */
export function bootstrapTheme(): void {
  cached = null;
  applyTheme(loadTheme());
}
