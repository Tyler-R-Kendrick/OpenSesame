import { normalizeLoopbackBaseUrl } from "@opensesame/api-client";
/**
 * Where the Host API is, for everything the extension says to it.
 *
 * Stored config is only trusted if it is still a loopback origin — a rewritten
 * `hostApiBase` must never repoint the extension at a remote Host API. Shared
 * by the background (health, the runner's session) and the options page.
 */
import {
  isSealedForRest,
  openFromRest,
  sealForRest,
} from "@opensesame/browser-at-rest";
import { ENDPOINTS, isString } from "@opensesame/os-domain";

export const DEFAULT_HOST = ENDPOINTS.host.default;
/** Where `hostApiBase` rests, sealed (ADR 0149). */
const STORE = "chrome.storage.local";

export async function resolveHostBase(): Promise<string> {
  try {
    const stored = await browser.storage.local.get("hostApiBase");
    const raw = stored.hostApiBase;
    // Sealed at rest (ADR 0149); a value from an older build reads as it is.
    const value = isString(raw)
      ? await openFromRest(STORE, "hostApiBase", raw)
      : null;
    if (isString(raw) && value && !isSealedForRest(raw)) {
      // Written in the clear by an older build: seal it where it lies.
      const sealed = await sealForRest(STORE, "hostApiBase", value);
      if (sealed !== null) {
        await browser.storage.local.set({ hostApiBase: sealed });
      }
    }
    if (value?.trim()) {
      const normalized = normalizeLoopbackBaseUrl(value);
      if (normalized) return normalized;
    }
  } catch {
    // storage may be unavailable in some test harnesses
  }
  return DEFAULT_HOST;
}
