/**
 * What a reset left behind, carried to the fresh document it leaves for.
 *
 * The tab that resets never stays: its memory describes storage that is gone
 * and its writes are halted, so it navigates to the app's root whatever the
 * report says. When something was left — a store that refused, or the
 * offline shell kept on purpose — the address carries it
 * (`?reset-failed=databases&reset-kept=caches,service_workers`), and the
 * fresh boot reads it once, takes it off the address, and the lock screens
 * show it (`ResetLeftNotice`). Only names from the closed set of areas are
 * read; anything else in those parameters is ignored.
 *
 * Imported by the shell's entry before anything renders, so it imports
 * nothing but the ports and never throws at import.
 */

import { maybePage } from "../ports.js";
import type { BrowserResetArea, BrowserResetReport } from "./browser-reset.js";

const AREAS = [
  "session",
  "origin_files",
  "databases",
  "web_storage",
  "push_subscription",
  "caches",
  "service_workers",
] as const satisfies readonly BrowserResetArea[];

const FAILED = "reset-failed";
const KEPT = "reset-kept";

export type LeftBehind = Readonly<{
  failed: readonly BrowserResetArea[];
  kept: readonly BrowserResetArea[];
}>;

function isArea(name: string): name is BrowserResetArea {
  return AREAS.some((area) => area === name);
}

function areas(value: string | null): BrowserResetArea[] {
  if (!value) return [];
  return [...new Set(value.split(","))].filter(isArea);
}

/** The address a reset leaves for: the root, and what it left, if anything. */
export function firstVisitAddress(
  base: string,
  report: BrowserResetReport,
): string {
  const params = new URLSearchParams();
  if (report.failed.length > 0) params.set(FAILED, report.failed.join(","));
  if (report.kept.length > 0) params.set(KEPT, report.kept.join(","));
  const query = params.toString();
  return query === "" ? base : `${base}?${query}`;
}

/** What an address says was left behind; null when it says nothing. */
export function readLeftBehind(search: string): LeftBehind | null {
  const params = new URLSearchParams(search);
  const failed = areas(params.get(FAILED));
  const kept = areas(params.get(KEPT));
  return failed.length === 0 && kept.length === 0 ? null : { failed, kept };
}

let landing: LeftBehind | null = null;
let captured = false;
const listeners = new Set<() => void>();

/**
 * Read this document's address once, before the router sees it, and take the
 * report off it so a reload or a shared link does not repeat it.
 */
export function captureLandingReset(): void {
  if (captured) return;
  captured = true;
  const page = maybePage();
  if (!page) return;
  const url = new URL(page.location.href);
  if (!url.searchParams.has(FAILED) && !url.searchParams.has(KEPT)) return;
  landing = readLeftBehind(url.search);
  url.searchParams.delete(FAILED);
  url.searchParams.delete(KEPT);
  page.replaceUrl(`${url.pathname}${url.search}${url.hash}`);
}

export function landingLeftBehind(): LeftBehind | null {
  return landing;
}

export function dismissLandingReset(): void {
  landing = null;
  for (const listener of listeners) listener();
}

export function onLandingResetChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: a document that has not read its address yet. */
export function resetLandingForTest(): void {
  landing = null;
  captured = false;
}
