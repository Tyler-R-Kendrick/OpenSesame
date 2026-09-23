/**
 * `settings/item-types/marketplaces.json` — the file that says which git
 * repositories this vault reads item types from (ADR 0134).
 *
 * The file is the configuration. The Marketplace view is drawn from what it
 * parses to, and every change the view makes is an edit to this text, so a
 * person reading the file in Settings' file viewer sees exactly what the view
 * acts on. Absent, the file reads as ours alone; emptied, it stays empty.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  DEFAULT_MARKETPLACE,
  parseMarketplaceSource,
  sourceReference,
} from "./source.js";

export const MAX_MARKETPLACES = 8;
const MAX_FILE_BYTES = 16_384;

export type MarketplacesParse =
  | { readonly ok: true; readonly sources: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** The one canonical spelling of a reference, or null when unreadable. */
export function canonicalReference(raw: string): string | null {
  const source = parseMarketplaceSource(raw);
  return source === null ? null : sourceReference(source);
}

export function encodeMarketplacesFile(sources: readonly string[]): string {
  return `${JSON.stringify({ marketplaces: sources }, null, 2)}\n`;
}

/** What the file says when nobody has written it. */
export const DEFAULT_MARKETPLACES_FILE = encodeMarketplacesFile([
  canonicalReference(DEFAULT_MARKETPLACE) ?? DEFAULT_MARKETPLACE,
]);

function refuse(message: string): MarketplacesParse {
  return { ok: false, message };
}

function readList(list: readonly BoundaryValue[]): MarketplacesParse {
  if (list.length > MAX_MARKETPLACES)
    return refuse(`At most ${MAX_MARKETPLACES} marketplaces.`);
  const sources: string[] = [];
  for (const [at, entry] of list.entries()) {
    const reference = isString(entry) ? canonicalReference(entry) : null;
    if (reference === null)
      return refuse(
        `marketplaces[${at}] is not a repository this page can read.`,
      );
    if (sources.includes(reference))
      return refuse(`marketplaces[${at}] repeats ${reference}.`);
    sources.push(reference);
  }
  return { ok: true, sources };
}

/** Parse the file strictly: one key, a list of references, nothing else. */
export function parseMarketplacesFile(text: string): MarketplacesParse {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES)
    return refuse(`The file exceeds ${MAX_FILE_BYTES} bytes.`);
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("The file is not JSON.");
  }
  if (!isJsonObject(parsed)) return refuse("The file is not an object.");
  const extra = Object.keys(parsed).find((key) => key !== "marketplaces");
  if (extra !== undefined) return refuse(`${extra} is not allowed.`);
  const list = parsed.marketplaces;
  if (!Array.isArray(list)) return refuse("marketplaces must be a list.");
  return readList(list);
}

export type MarketplacesEdit =
  | { readonly ok: true; readonly text: string; readonly reference: string }
  | { readonly ok: false; readonly message: string };

/** The file with one more repository at the end. */
export function withMarketplace(text: string, raw: string): MarketplacesEdit {
  const current = parseMarketplacesFile(text);
  if (!current.ok) return current;
  const reference = canonicalReference(raw);
  if (reference === null)
    return {
      ok: false,
      message:
        "Not a repository this page can read. Use owner/repo, a GitHub, GitLab, Codeberg or Bitbucket address, gitea+https://host/owner/repo, or the raw address of .opensesame/marketplace.json.",
    };
  if (current.sources.includes(reference))
    return { ok: false, message: "That marketplace is already listed." };
  if (current.sources.length >= MAX_MARKETPLACES)
    return { ok: false, message: `At most ${MAX_MARKETPLACES} marketplaces.` };
  return {
    ok: true,
    reference,
    text: encodeMarketplacesFile([...current.sources, reference]),
  };
}

/** The file without one repository. */
export function withoutMarketplace(
  text: string,
  reference: string,
): MarketplacesEdit {
  const current = parseMarketplacesFile(text);
  if (!current.ok) return current;
  return {
    ok: true,
    reference,
    text: encodeMarketplacesFile(
      current.sources.filter((entry) => entry !== reference),
    ),
  };
}

/** Ours put back first, keeping whatever else is listed. */
export function withDefaultMarketplace(text: string): MarketplacesEdit {
  const current = parseMarketplacesFile(text);
  // A file that does not parse is the person's to fix; restoring over it
  // would erase whatever they were in the middle of writing.
  if (!current.ok) return current;
  const ours = canonicalReference(DEFAULT_MARKETPLACE) ?? DEFAULT_MARKETPLACE;
  const rest = current.sources.filter((entry) => entry !== ours);
  if (rest.length >= MAX_MARKETPLACES)
    return { ok: false, message: `At most ${MAX_MARKETPLACES} marketplaces.` };
  return {
    ok: true,
    reference: ours,
    text: encodeMarketplacesFile([ours, ...rest]),
  };
}

export function isDefaultMarketplace(reference: string): boolean {
  return reference === canonicalReference(DEFAULT_MARKETPLACE);
}
