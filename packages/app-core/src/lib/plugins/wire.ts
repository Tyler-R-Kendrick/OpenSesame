/**
 * What the daemon's plugin routes answer, read strictly (ADR 0150 §7):
 *
 *   GET /v1/plugins              → { plugins: [PluginState, …] }
 *   PUT /v1/plugins/{id}         → PluginState | 404 not_installed | 400 unknown_plugin
 *   GET /v1/plugins/{id}/notices → { notices: [{ event_type, severity,
 *                                   occurred_at, summary, subject_id? }] }
 *
 * The daemon is somebody else's process at the end of a network, so every
 * field is checked and anything this page does not know is dropped: a plugin
 * id outside the catalog, a capability that is not that plugin's, a notice
 * whose name is not an event name. A notice keeps its name, time and subject
 * only — the summary is never read — and a subject that looks like an
 * `osr_` surrogate is dropped, so a daemon that got it wrong still cannot put
 * one on the page.
 */

import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type PluginId, isPluginId, pluginById } from "./catalog.js";

/** One plugin as the daemon reports it (`opensesame-plugin-settings`). */
export type PluginState = Readonly<{
  id: PluginId;
  installed: boolean;
  version: string | null;
  enabled: boolean;
  forcedOff: boolean;
  active: boolean;
}>;

/** A tripwire: which event, when, and about what. Nothing else. */
export type PluginNotice = Readonly<{
  event: string;
  at: string;
  subject: string | null;
}>;

/** What the panel draws: one of four, derived rather than trusted. */
export type PluginStanding = "not-installed" | "off" | "on" | "forced-off";

export const MAX_NOTICES = 50;

const EVENT = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z0-9_]{1,31}){1,4}$/;
const SUBJECT = /^[A-Za-z0-9._:/@-]{1,128}$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;
/** An `osr_…` surrogate, anywhere in a string, whatever its case. */
const SURROGATE = /osr_/i;

/**
 * Off unless every fact says on: a plugin reported active while forced off
 * or not installed reads as forced off or not installed. Nothing the daemon
 * says can make this page show a plugin running that should not be.
 */
export function standingOf(state: PluginState): PluginStanding {
  if (!state.installed) return "not-installed";
  if (state.forcedOff) return "forced-off";
  return state.active && state.enabled ? "on" : "off";
}

function bool(value: BoundaryValue | undefined): boolean | null {
  return isBoolean(value) ? value : null;
}

/** One `PluginState`, or null when it is not one this page will draw. */
export function parsePluginState(raw: BoundaryValue): PluginState | null {
  if (!isJsonObject(raw)) return null;
  const { id, capability, version } = raw;
  if (!isString(id) || !isPluginId(id)) return null;
  if (capability !== pluginById(id).capability) return null;
  const installed = bool(raw.installed);
  const enabled = bool(raw.enabled);
  const forcedOff = bool(raw.forced_off);
  const active = bool(raw.active);
  if (
    installed === null ||
    enabled === null ||
    forcedOff === null ||
    active === null
  )
    return null;
  const known = isString(version) && VERSION.test(version) ? version : null;
  // Absent or null is "no version"; anything else must be a version.
  if (known === null && version !== null && version !== undefined) return null;
  return {
    id,
    installed,
    version: known,
    enabled,
    forcedOff,
    active,
  };
}

/** `{ plugins: [...] }`: known plugins, first answer for each, catalog order kept by the caller. */
export function parsePluginList(raw: BoundaryValue): PluginState[] | null {
  if (!isJsonObject(raw) || !Array.isArray(raw.plugins)) return null;
  const seen = new Set<string>();
  const out: PluginState[] = [];
  for (const entry of raw.plugins) {
    const state = parsePluginState(entry);
    if (state === null || seen.has(state.id)) continue;
    seen.add(state.id);
    out.push(state);
  }
  return out;
}

function parseNotice(raw: BoundaryValue): PluginNotice | null {
  if (!isJsonObject(raw)) return null;
  const { event_type: event, occurred_at: at, subject_id: subject } = raw;
  if (!isString(event) || !EVENT.test(event)) return null;
  if (SURROGATE.test(event)) return null;
  if (!isString(at) || at.length > 40) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  const safeSubject =
    isString(subject) && SUBJECT.test(subject) && !SURROGATE.test(subject)
      ? subject
      : null;
  return { event, at: new Date(at).toISOString(), subject: safeSubject };
}

/** `{ notices: [...] }`, newest first as sent, at most {@link MAX_NOTICES}. */
export function parseNoticeList(raw: BoundaryValue): PluginNotice[] | null {
  if (!isJsonObject(raw) || !Array.isArray(raw.notices)) return null;
  const out: PluginNotice[] = [];
  for (const entry of raw.notices) {
    if (out.length >= MAX_NOTICES) break;
    const notice = parseNotice(entry);
    if (notice !== null) out.push(notice);
  }
  return out;
}

/** The daemon's `{"error": code}`, when it sent one. */
export function errorCodeOf(raw: BoundaryValue): string | null {
  return isJsonObject(raw) && isString(raw.error) ? raw.error : null;
}
