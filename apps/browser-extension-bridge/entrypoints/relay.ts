import { RELAY_MESSAGE } from "@/lib/relay-wire";
/**
 * The relay (ADR 0199). An unlisted script: it has no manifest
 * `content_scripts` entry. The background registers it at runtime, top frame
 * only, for the one origin a person switched the bridge on for.
 *
 * It does one thing: a message the page posts to itself in the bridge's
 * channel, from the page's own origin, is handed to the background, and the
 * background's answer is posted back, once it decodes as an answer to that
 * question. It reads nothing else from the page and draws nothing into it.
 */
import {
  pageReplyMessage,
  parsePageReply,
  parsePageRequest,
} from "@opensesame/connector-bridge";

export default defineUnlistedScript(() => {
  // One relay per document, whichever way it was injected.
  const marked = document.documentElement.dataset;
  if (marked.opensesameBridgeRelay === "1") return;
  marked.opensesameBridgeRelay = "1";
  const origin = window.location.origin;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== origin) return;
    const request = parsePageRequest(event.data);
    if (!request) return;
    const refuse = () =>
      window.postMessage(
        pageReplyMessage({ id: request.id, error: "network" }),
        origin,
      );
    browser.runtime
      .sendMessage({ type: RELAY_MESSAGE, message: event.data })
      .then((answer) => {
        if (parsePageReply(answer, request.op))
          window.postMessage(answer, origin);
        else refuse();
      }, refuse);
  });
});
