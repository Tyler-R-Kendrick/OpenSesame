/**
 * Extension background: Host API + client-core sync cursor + optional daemon.
 * Never exposes getSecret to webpages.
 */
import { createApiClient } from "@opensesame/api-client";
import { createCursor, persistSealedStore } from "@opensesame/client-core";

export default defineBackground(() => {
  const hostBase = "http://127.0.0.1:8787";
  const cursor = createCursor("extension-device");

  chrome.runtime.onInstalled.addListener(() => {
    void persistSealedStore(
      cursor.deviceId,
      JSON.stringify({
        cursor: { device_id: cursor.deviceId, epoch: cursor.epoch },
        blobs: [],
      }),
    );
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "opensesame.health") {
      void (async () => {
        const client = createApiClient({ baseUrl: hostBase });
        const health = await client.health();
        const daemon = await client.probeDaemon();
        const discovery = await client.discover();
        sendResponse({ health, daemon, discovery, cursor });
      })();
      return true;
    }
    if (message?.type === "opensesame.sync_cursor") {
      sendResponse({ cursor });
      return true;
    }
  });
});
