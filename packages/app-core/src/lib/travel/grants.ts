/**
 * The site grants a vault carries (ADR 0143): its site-broker consents and
 * domain policy, kept in plaintext beside it under its name rather than its
 * key. They are read with the broker's own parsers (`site-broker-records`).
 *
 * What lets a site in — a consent, a whitelist rule — comes back from a
 * bundle only on the person's word: a bundle is trusted only as far as its
 * return code. What keeps a site out — a blacklist rule — always survives,
 * the bundle's and the device's alike. Nothing here can loosen the policy a
 * vault comes home to.
 */

import { kvFileName } from "../kv.js";
import { scopedKey } from "../projects.js";
import {
  CONSENTS_KEY,
  type DomainRule,
  POLICY_KEY,
  parseBrokerPolicy,
  parseConsents,
  sortRules,
} from "../site-broker-records.js";
import type { TravelFile } from "./bundle-format.js";
import type { TravelStorage } from "./storage.js";

export type TravelGrants = Readonly<{
  /** Sites a consent or a whitelist rule lets in, sorted. */
  sites: readonly string[];
}>;

export type GrantFiles = Readonly<{ consents: string; policy: string }>;

/** A vault's grant records, as origin file names. */
export function grantFilesOf(id: string): GrantFiles {
  return {
    consents: kvFileName(scopedKey(CONSENTS_KEY, id)),
    policy: kvFileName(scopedKey(POLICY_KEY, id)),
  };
}

export function isGrantFile(id: string, file: string): boolean {
  const files = grantFilesOf(id);
  return file === files.consents || file === files.policy;
}

function textOf(files: readonly TravelFile[], file: string): string | null {
  return files.find((entry) => entry.file === file)?.text ?? null;
}

/** What the grant records among `files` would let in. */
export function grantsIn(
  id: string,
  files: readonly TravelFile[],
): TravelGrants {
  const names = grantFilesOf(id);
  const sites = new Set(
    parseConsents(textOf(files, names.consents)).map((c) => c.origin),
  );
  for (const rule of parseBrokerPolicy(textOf(files, names.policy)).rules) {
    if (rule.effect === "whitelist") sites.add(rule.domain);
  }
  return { sites: [...sites].sort() };
}

const blocksOf = (raw: string | null) =>
  parseBrokerPolicy(raw).rules.filter((rule) => rule.effect === "blacklist");

/** Rules by domain, a block winning over an allow for the same domain. */
function merged(rules: readonly DomainRule[]): DomainRule[] {
  const byDomain = new Map<string, DomainRule>();
  for (const rule of rules) {
    const seen = byDomain.get(rule.domain);
    if (!seen || rule.effect === "blacklist") byDomain.set(rule.domain, rule);
  }
  return sortRules([...byDomain.values()]);
}

async function put(
  storage: TravelStorage,
  file: string,
  text: string | null,
): Promise<void> {
  if (text === null) await storage.remove(file);
  else await storage.write(file, text);
}

/**
 * Write a returning vault's grant records. With `restore`, the bundle's
 * consents and rules come back; without it, no consent survives and the
 * policy keeps only blocks. Blocks from the bundle and from the device are
 * always kept. Returns the files touched.
 */
export async function writeGrants(
  storage: TravelStorage,
  id: string,
  bundle: readonly TravelFile[],
  restore: boolean,
): Promise<string[]> {
  const names = grantFilesOf(id);
  const fromBundle = textOf(bundle, names.policy);
  const rules = merged([
    ...(restore ? parseBrokerPolicy(fromBundle).rules : blocksOf(fromBundle)),
    ...blocksOf(await storage.read(names.policy)),
  ]);
  const consents = restore ? textOf(bundle, names.consents) : null;
  await put(storage, names.consents, consents);
  await put(
    storage,
    names.policy,
    rules.length > 0 ? JSON.stringify({ rules }) : null,
  );
  return [names.consents, names.policy];
}

/** Drop whatever lets a site in for `id`, keeping its blocks. */
export function dropAllows(storage: TravelStorage, id: string) {
  return writeGrants(storage, id, [], false);
}
