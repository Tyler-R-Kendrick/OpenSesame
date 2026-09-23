import { maybeLocalStore } from "../ports.js";
/**
 * The raw text of each settings document (`settings/general.yaml`, …), kept
 * per path so a hand-written comment survives a save and a reload. The typed
 * projection in `settings.ts` is what the text parses to; this is the document
 * as the person wrote it.
 */
const KEY = "opensesame.settings-source";

type SourceMap = Record<string, string>;

function readAll(): SourceMap {
  try {
    const raw = maybeLocalStore()?.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: SourceMap = {};
    for (const [path, text] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof text === "string") out[path] = text;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadSettingsSource(path: string): string | undefined {
  return readAll()[path];
}

export function saveSettingsSource(path: string, text: string): void {
  const next = { ...readAll(), [path]: text };
  try {
    maybeLocalStore()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or absent store keeps the typed projection working: the comment
    // is preserved for the session and re-derived values still round-trip.
  }
}
