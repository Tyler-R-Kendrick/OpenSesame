import { createBridge } from "@/lib/bridge";
import { browserPorts, senderFacts } from "@/lib/browser-ports";
import { POPUP_MESSAGE, handlePopup, parsePopupMessage } from "@/lib/popup-api";
import { relayedMessage } from "@/lib/relay-wire";
/**
 * The bridge's background (ADR 0199). It answers two kinds of message: a
 * page's request, relayed by the relay script it registered, and the popup's.
 * Every message is decoded before anything acts on it, and a sender the
 * browser does not vouch for is refused.
 */
import {
  connectorBridgeTable,
  pageReplyMessage,
  parsePageRequest,
} from "@opensesame/connector-bridge";

export default defineBackground(() => {
  const bridge = createBridge(
    browserPorts(),
    connectorBridgeTable,
    browser.runtime.getManifest().version,
  );

  // A grant or a registration the person took back in the browser's own
  // settings is gone here too.
  const reconcile = () => {
    void bridge.sites.reconcile();
    void bridge.hosts.reconcile();
  };
  browser.permissions.onRemoved.addListener(reconcile);
  browser.permissions.onAdded.addListener(reconcile);
  browser.runtime.onStartup.addListener(reconcile);
  browser.runtime.onInstalled.addListener(reconcile);

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const facts = senderFacts(sender);
    const relayed = relayedMessage(message);
    if (relayed !== null) {
      const request = parsePageRequest(relayed);
      if (!request) {
        sendResponse(null);
        return undefined;
      }
      bridge.relay(request, facts).then(
        (reply) => sendResponse(pageReplyMessage(reply)),
        () =>
          sendResponse(pageReplyMessage({ id: request.id, error: "network" })),
      );
      return true;
    }
    if (message?.type === POPUP_MESSAGE) {
      const action = parsePopupMessage(message);
      if (!action) {
        sendResponse({ error: "bad_message" });
        return undefined;
      }
      handlePopup(bridge, action, facts).then(sendResponse, () =>
        sendResponse({ error: "bad_message" }),
      );
      return true;
    }
    return undefined;
  });
});
