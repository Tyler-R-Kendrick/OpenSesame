/**
 * Extension background: Host API + client-core sync cursor + optional daemon.
 * Never exposes getSecret to webpages.
 */
import {
  createApiClient,
  normalizeLoopbackBaseUrl,
} from "@opensesame/api-client";
import {
  isSealedForRest,
  openFromRest,
  sealForRest,
} from "@opensesame/browser-at-rest";
import { createCursor, persistSealedStore } from "@opensesame/client-core";
import { ENDPOINTS, isString } from "@opensesame/os-domain";

const DEFAULT_HOST = ENDPOINTS.host.default;
/** Where `hostApiBase` rests, sealed (ADR 0149). */
const STORE = "chrome.storage.local";

/**
 * Stored config is only trusted if it is still a loopback origin — a rewritten
 * `hostApiBase` must never repoint the extension at a remote Host API.
 */
async function resolveHostBase(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get("hostApiBase");
    const raw = stored.hostApiBase;
    // Sealed at rest (ADR 0149); a value from an older build reads as it is.
    const value = isString(raw)
      ? await openFromRest(STORE, "hostApiBase", raw)
      : null;
    if (isString(raw) && value && !isSealedForRest(raw)) {
      // Written in the clear by an older build: seal it where it lies.
      const sealed = await sealForRest(STORE, "hostApiBase", value);
      if (sealed !== null) {
        await chrome.storage.local.set({ hostApiBase: sealed });
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

export default defineBackground(() => {
  const cursor = createCursor("extension-device");

  chrome.runtime.onInstalled.addListener(() => {
    void persistSealedStore(
      cursor.deviceId,
      JSON.stringify({
        cursor: { device_id: cursor.deviceId, epoch: cursor.epoch },
        blobs: [],
      }),
      // The store's file is sealed at rest too (ADR 0149).
      { sealForRest, openFromRest },
    );
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "opensesame.health") {
      void (async () => {
        try {
          const hostBase = await resolveHostBase();
          const client = createApiClient({ baseUrl: hostBase });
          const health = await client.health();
          const daemon = await client.probeDaemon();
          const discovery = await client.discover();
          sendResponse({ health, daemon, discovery, cursor, hostBase });
        } catch (e) {
          sendResponse({
            error: e instanceof Error ? e.message : String(e),
            cursor,
          });
        }
      })();
      return true;
    }
    if (message?.type === "opensesame.sync_cursor") {
      sendResponse({ cursor });
      return true;
    }
  });
});
