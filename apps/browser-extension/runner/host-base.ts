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
import {
  type BoundaryObject,
  ENDPOINTS,
  isString,
} from "@opensesame/os-domain";

export const DEFAULT_HOST = ENDPOINTS.host.default;
/** Where `hostApiBase` rests, sealed (ADR 0149). */
const STORE = "chrome.storage.local";

export interface HostBaseGuard {
  authorize(): Promise<void>;
  /** Page callers additionally pin the local ticket at synchronous dispatch. */
  check?(): void;
}
function checkOriginalNow(owner: HostBaseGuard | undefined) {
  owner?.check?.();
}
async function checkOriginal(owner: HostBaseGuard | undefined) {
  if (owner) {
    owner.check?.();
    await owner.authorize();
    owner.check?.();
  }
}
export async function resolveHostBase(owner?: HostBaseGuard): Promise<string> {
  await checkOriginal(owner);
  checkOriginalNow(owner);
  try {
    const stored =
      await browser.storage.local.get<BoundaryObject>("hostApiBase");
    await checkOriginal(owner);
    checkOriginalNow(owner);
    const raw = stored.hostApiBase;
    // Sealed at rest (ADR 0149); a value from an older build reads as it is.
    const value = isString(raw)
      ? await openFromRest(STORE, "hostApiBase", raw)
      : null;
    await checkOriginal(owner);
    checkOriginalNow(owner);
    if (isString(raw) && value && !isSealedForRest(raw)) {
      // Written in the clear by an older build: seal it where it lies.
      const sealed = await sealForRest(STORE, "hostApiBase", value);
      await checkOriginal(owner);
      checkOriginalNow(owner);
      if (sealed !== null) {
        await browser.storage.local.set({ hostApiBase: sealed });
        await checkOriginal(owner);
        checkOriginalNow(owner);
      }
    }
    if (value?.trim()) {
      const normalized = normalizeLoopbackBaseUrl(value);
      if (normalized) return normalized;
    }
  } catch {
    await checkOriginal(owner);
    checkOriginalNow(owner);
    // storage may be unavailable in some test harnesses
  }
  return DEFAULT_HOST;
}
