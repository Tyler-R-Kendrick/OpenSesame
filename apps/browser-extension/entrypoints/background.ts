/**
 * Extension background: Host API + optional daemon probe.
 * Never exposes getSecret to webpages.
 */
import { createApiClient } from "@opensesame/api-client";

export default defineBackground(() => {
  const hostBase = "http://127.0.0.1:8787";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "opensesame.health") {
      return;
    }
    void (async () => {
      const client = createApiClient({ baseUrl: hostBase });
      const health = await client.health();
      const daemon = await client.probeDaemon();
      sendResponse({ health, daemon });
    })();
    return true;
  });
});
