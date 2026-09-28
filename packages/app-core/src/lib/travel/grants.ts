/**
 * The site grants a vault carries (ADR 0143): the site-broker consents and
 * policy records kept in plaintext beside it. They authorize sites, so a
 * bundle — trusted only as far as its own return code — never writes them
 * back unless the person says so in the return preview. A vault comes home
 * without them by default; its sites ask again.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvFileName } from "../kv.js";
import { scopedKey } from "../projects.js";
import type { TravelFile } from "./bundle-format.js";

const GRANT_KEYS = ["site-broker.consents.v1", "site-broker.policy.v1"];

export type TravelGrants = Readonly<{
  /** Origins a consent record lets in without asking. */
  sites: readonly string[];
  /** Broker policy rules. */
  rules: number;
}>;

/** A vault's grant records, as origin file names. */
export function grantFilesOf(id: string): ReadonlySet<string> {
  return new Set(GRANT_KEYS.map((key) => kvFileName(scopedKey(key, id))));
}

function listOf(text: string, member: string): BoundaryValue[] {
  try {
    const parsed: BoundaryValue = JSON.parse(text);
    const value = isJsonObject(parsed) ? parsed[member] : undefined;
    return Array.isArray(value) ? value : [];
  } catch {
    // A record that does not parse grants nothing a site could use.
    return [];
  }
}

/** What the grant records among `files` would let in. */
export function grantsIn(
  id: string,
  files: readonly TravelFile[],
): TravelGrants {
  const [consentsFile, policyFile] = [...grantFilesOf(id)];
  const sites = new Set<string>();
  let rules = 0;
  for (const entry of files) {
    if (entry.file === consentsFile) {
      for (const consent of listOf(entry.text, "consents")) {
        if (isJsonObject(consent) && isString(consent.origin)) {
          sites.add(consent.origin);
        }
      }
    } else if (entry.file === policyFile) {
      rules += listOf(entry.text, "rules").length;
    }
  }
  return { sites: [...sites].sort(), rules };
}
