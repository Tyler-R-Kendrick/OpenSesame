/**
 * Settings › Vaults › Item types as a list of switches (ADR 0165).
 *
 * Pure: the rows a screen draws from the pack state, and the sentence each
 * one carries for assistive technology and the status glyph. The component
 * adds nothing the model did not say, so a row's meaning is testable without
 * a DOM.
 */

import { type PackEntry, packEntries } from "@opensesame/vault-item-types";
import { neededBy } from "../../lib/type-packs/requires.js";
import {
  type PackPhase,
  type PackSnapshot,
  isBusy,
  statusOf,
} from "../../lib/type-packs/state.js";

export type PackControl =
  /** A switch a person may press. */
  | "switch"
  /** On, and not theirs to turn off: the vault holds items of it, or another type needs it. */
  | "held"
  /** On because a capability put it there; its own switch is the one to press. */
  | "managed";

export type PackRow = Readonly<{
  id: string;
  title: string;
  extension: string;
  summary: string;
  /** "9 fields · 1.9 KB": what it is, and what switching it on downloads. */
  facts: string;
  phase: PackPhase;
  /** The switch's position: on, or on its way to being. */
  checked: boolean;
  busy: boolean;
  control: PackControl;
  /** Items of this type the open vault holds. */
  held: number;
  /** Why it failed, or null. */
  reason: string | null;
  /** The sentence for the row's accessible description and its glyph. */
  sentence: string;
}>;

export type PackGroup = Readonly<{
  id: string;
  label: string;
  rows: readonly PackRow[];
}>;

/** In the order a person reaches for them. Anything else follows, A to Z. */
const GROUP_ORDER: readonly string[] = [
  "access",
  "developer",
  "finance",
  "identity",
  "documents",
];

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function pluralFields(count: number): string {
  return count === 1 ? "1 field" : `${count} fields`;
}

export function packFacts(entry: PackEntry): string {
  return `${pluralFields(entry.fields)} · ${formatBytes(entry.bytes)}`;
}

function groupOf(entry: PackEntry): string {
  return entry.categories[0] ?? "other";
}

/** A reason ends the sentence it is put in, so it brings no full stop of its own. */
function bare(reason: string | null): string {
  return (reason ?? "it did not install").replace(/\.+$/, "");
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function sentenceFor(
  title: string,
  phase: PackPhase,
  control: PackControl,
  held: number,
  reason: string | null,
  needing: string | null,
): string {
  if (control === "held" && held === 0 && needing !== null) {
    return `${title} stays on: ${needing} needs it.`;
  }
  if (control === "held") {
    return held === 1
      ? `${title} stays on: this vault has 1 item of it.`
      : `${title} stays on: this vault has ${held} items of it.`;
  }
  if (control === "managed") {
    return `${title} is on through a capability in Settings › Capabilities.`;
  }
  switch (phase) {
    case "queued":
      return `${title} is waiting to download.`;
    case "downloading":
      return `Downloading ${title}.`;
    case "installing":
      return `Installing ${title}.`;
    case "on":
      return `${title} is on.`;
    case "failed":
      return `${title} did not install: ${bare(reason)}.`;
    default:
      return `${title} is off.`;
  }
}

function rowFor(
  entry: PackEntry,
  snapshot: PackSnapshot,
  managed: ReadonlySet<string>,
): PackRow {
  const status = statusOf(entry.id, snapshot);
  const held = snapshot.counts.get(entry.id) ?? 0;
  const on = status.phase === "on";
  const needing = neededBy(
    entry.id,
    (pack) => statusOf(pack, snapshot).phase === "on",
  );
  const control: PackControl =
    on && (held > 0 || needing !== null)
      ? "held"
      : managed.has(entry.id)
        ? "managed"
        : "switch";
  const reason = status.reason ?? null;
  return {
    id: entry.id,
    title: entry.title,
    extension: entry.extension,
    summary: entry.summary,
    facts: packFacts(entry),
    phase: status.phase,
    checked: on || isBusy(status.phase),
    busy: isBusy(status.phase),
    control,
    held,
    reason,
    sentence: sentenceFor(
      entry.title,
      status.phase,
      control,
      held,
      reason,
      needing,
    ),
  };
}

function matches(row: PackRow, group: string, query: string): boolean {
  if (query === "") return true;
  const haystack = `${row.title} ${row.extension} ${row.summary} ${group}`;
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.toLowerCase().includes(word));
}

/**
 * The list a screen draws: every pack grouped by what it is for, filtered by
 * the search words (all of them, anywhere in title, extension, summary or
 * group).
 */
export type PackListOptions = {
  query?: string;
  managed?: ReadonlySet<string>;
};

export function packGroups(
  snapshot: PackSnapshot,
  options: PackListOptions = {},
): readonly PackGroup[] {
  const query = (options.query ?? "").trim();
  const managed = options.managed ?? new Set<string>();
  const byGroup = new Map<string, PackRow[]>();
  for (const entry of packEntries()) {
    const group = groupOf(entry);
    const row = rowFor(entry, snapshot, managed);
    if (!matches(row, group, query)) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), row]);
  }
  const rank = (id: string) => {
    const at = GROUP_ORDER.indexOf(id);
    return at === -1 ? GROUP_ORDER.length : at;
  };
  return [...byGroup.entries()]
    .sort(
      ([left], [right]) =>
        rank(left) - rank(right) || left.localeCompare(right),
    )
    .map(([id, rows]) => ({
      id,
      label: capitalise(id),
      rows: [...rows].sort((a, b) => a.title.localeCompare(b.title)),
    }));
}

/** "7 of 18 on" — what the head says about the whole list. */
export function packTally(snapshot: PackSnapshot): string {
  const entries = packEntries();
  const on = entries.filter((entry) => {
    const { phase } = statusOf(entry.id, snapshot);
    return phase === "on";
  }).length;
  return `${on} of ${entries.length} on`;
}

/** What to say when the state of one pack just changed, or null to stay quiet. */
export function transitionSentence(
  title: string,
  before: PackPhase,
  after: PackPhase,
  reason: string | null,
): string | null {
  if (before === after) return null;
  if (after === "on") return `${title} installed.`;
  if (after === "failed") {
    return `${title} did not install: ${bare(reason)}.`;
  }
  if (after === "off" && (before === "on" || isBusy(before))) {
    return before === "on" ? `${title} removed.` : `${title} cancelled.`;
  }
  if (after === "downloading") return `Downloading ${title}.`;
  return null;
}
