/**
 * Read a marketplace: its index, then each definition it lists (ADR 0134).
 *
 * Only a person pressing the load key starts this — nothing on the page reads
 * a marketplace by itself (the capability's egress is declared non-automatic).
 * Every request is an anonymous GET: no cookie, no referrer, no redirect
 * followed, one timer over headers and body, a byte cap on the body. What
 * comes back is text, parsed by the same strict `VaultItemType` parser a
 * pasted definition goes through; a marketplace confers no trust at all.
 */

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { isJsonObject, isString } from "@opensesame/os-domain";
import {
  type ItemTypeDefinition,
  MAX_DEFINITION_BYTES,
  describeErrors,
  parseDefinition,
} from "@opensesame/vault-item-types";
import {
  type IndexedType,
  MAX_INDEX_BYTES,
  type MarketplaceIndex,
  parseMarketplaceIndex,
} from "./marketplace-index.js";
import {
  INDEX_PATH,
  type MarketplaceSource,
  bitbucketRepositoryUrl,
  rawFileUrl,
} from "./source.js";

const TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

export type MarketplaceFailure = "unanswered" | "missing" | "malformed";

export class MarketplaceError extends Error {
  readonly name = "MarketplaceError";
  readonly failure: MarketplaceFailure;
  constructor(failure: MarketplaceFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

export type MarketplaceOffer =
  | {
      readonly ok: true;
      readonly path: string;
      /** The exact bytes installed — what the pin, if any, was checked over. */
      readonly text: string;
      readonly sha256: string;
      readonly definition: ItemTypeDefinition;
    }
  | { readonly ok: false; readonly path: string; readonly problem: string };

export type MarketplaceListing = {
  readonly name: string;
  readonly description: string;
  readonly offers: readonly MarketplaceOffer[];
};

export const marketplaceFetch = {
  fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
};

async function readCapped(response: Response, max: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  // `ignoreBOM` keeps a byte-order mark in the text, so re-encoding it gives
  // back the exact bytes served: the SHA-256 a pin is checked against is the
  // one `scripts/pin-marketplace.mjs` wrote over the file on disk.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let out = "";
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > max) {
      await reader.cancel();
      throw new MarketplaceError("malformed", `a file exceeds ${max} bytes`);
    }
    out += decoder.decode(part.value, { stream: true });
  }
  return out + decoder.decode();
}

/** One anonymous GET, capped, timed, and never redirected. */
export async function fetchText(url: string, max: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await marketplaceFetch.fetch(url, {
        method: "GET",
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-cache",
        signal: controller.signal,
      });
    } catch {
      throw new MarketplaceError(
        "unanswered",
        "The repository did not answer.",
      );
    }
    if (response.status === 404)
      throw new MarketplaceError("missing", "Not found in the repository.");
    if (!response.ok)
      throw new MarketplaceError(
        "unanswered",
        `The repository answered ${response.status}.`,
      );
    try {
      return await readCapped(response, max);
    } catch (error) {
      if (error instanceof MarketplaceError) throw error;
      throw new MarketplaceError(
        "unanswered",
        "The repository did not answer.",
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Bitbucket has no `HEAD` alias on its file route: ask for the main branch. */
async function resolveRef(source: MarketplaceSource): Promise<string | null> {
  if (source.forge !== "bitbucket" || source.ref !== null)
    return source.forge === "raw" ? null : source.ref;
  const text = await fetchText(bitbucketRepositoryUrl(source), 262_144);
  try {
    const record = JSON.parse(text);
    const branch = isJsonObject(record) ? record.mainbranch : undefined;
    if (isJsonObject(branch) && isString(branch.name)) return branch.name;
  } catch {
    // Fall through to the refusal below.
  }
  throw new MarketplaceError("malformed", "Bitbucket named no main branch.");
}

async function readOffer(
  source: MarketplaceSource,
  ref: string | null,
  entry: IndexedType,
): Promise<MarketplaceOffer> {
  const path = entry.path;
  let text: string;
  try {
    text = await fetchText(rawFileUrl(source, path, ref), MAX_DEFINITION_BYTES);
  } catch (error) {
    const problem = error instanceof Error ? error.message : "Unreadable.";
    return { ok: false, path, problem };
  }
  const digest = bytesToHex(sha256(new TextEncoder().encode(text)));
  if (entry.sha256 !== null && entry.sha256 !== digest)
    return { ok: false, path, problem: "Does not match the pinned SHA-256." };
  if (text.startsWith("\uFEFF"))
    return {
      ok: false,
      path,
      problem: "Starts with a byte-order mark; save it as UTF-8 without one.",
    };
  const parsed = parseDefinition(text, "community");
  if (!parsed.ok)
    return { ok: false, path, problem: describeErrors(parsed.errors) };
  return {
    ok: true,
    path,
    text,
    sha256: digest,
    definition: parsed.definition,
  };
}

async function readAll(
  source: MarketplaceSource,
  ref: string | null,
  index: MarketplaceIndex,
): Promise<MarketplaceOffer[]> {
  const offers: MarketplaceOffer[] = new Array(index.itemTypes.length);
  let next = 0;
  const worker = async () => {
    while (next < index.itemTypes.length) {
      const at = next;
      next += 1;
      const entry = index.itemTypes[at];
      if (entry) offers[at] = await readOffer(source, ref, entry);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return offers;
}

/** Read one marketplace whole. Throws `MarketplaceError` on the index only. */
export async function loadMarketplace(
  source: MarketplaceSource,
): Promise<MarketplaceListing> {
  const ref = await resolveRef(source);
  let text: string;
  try {
    text = await fetchText(
      rawFileUrl(source, INDEX_PATH, ref),
      MAX_INDEX_BYTES,
    );
  } catch (error) {
    if (error instanceof MarketplaceError && error.failure === "missing")
      throw new MarketplaceError(
        "missing",
        `No ${INDEX_PATH} in that repository.`,
      );
    throw error;
  }
  const parsed = parseMarketplaceIndex(text);
  if (!parsed.ok) throw new MarketplaceError("malformed", parsed.message);
  const offers = await readAll(source, ref, parsed.index);
  return {
    name: parsed.index.name,
    description: parsed.index.description,
    offers,
  };
}
