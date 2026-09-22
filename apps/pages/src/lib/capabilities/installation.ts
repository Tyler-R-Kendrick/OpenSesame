/**
 * The installation id (ownership.md §4.5): one random opaque id per browser
 * installation, minted the first time the core boot asks for it and never
 * derived from anything a person could be identified by. It scopes the
 * installation selection and the consent receipt; it is not a secret and
 * grants nothing.
 */

import { kvGet, kvSet, kvSetDurable } from "../kv.js";
import { INSTALLATION_KEY } from "./keys.js";

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

let cached: string | null = null;

function readStored(): string | null {
  const raw = kvGet(INSTALLATION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" && ID_RE.test(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mint(): string {
  return crypto.randomUUID();
}

/**
 * The installation id, minting one when none is stored. The write is
 * best-effort here; `ensureInstallationId` is what boot awaits so the id
 * survives the reload.
 */
export function installationId(): string {
  if (cached) return cached;
  const stored = readStored();
  if (stored) {
    cached = stored;
    return stored;
  }
  const fresh = mint();
  cached = fresh;
  kvSet(INSTALLATION_KEY, JSON.stringify(fresh));
  return fresh;
}

/** Boot-time: mint if needed and wait for the durable write. */
export async function ensureInstallationId(): Promise<string> {
  const stored = readStored();
  if (stored) {
    cached = stored;
    return stored;
  }
  const fresh = cached ?? mint();
  try {
    await kvSetDurable(INSTALLATION_KEY, JSON.stringify(fresh));
  } catch {
    // Session-only storage: the id lives for this tab, and the store reports
    // durability separately rather than pretending the id was saved.
  }
  cached = fresh;
  return fresh;
}

/** Test-only: forget the cached id so a case starts from storage. */
export function resetInstallationIdForTest(): void {
  cached = null;
}
