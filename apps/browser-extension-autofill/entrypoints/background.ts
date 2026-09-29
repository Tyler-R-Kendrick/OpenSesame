/**
 * The companion's background (ADR 0150 §6.4, §7): fill by reference, started
 * only by a gesture on this extension's own UI, only on sites a person
 * switched on. Never exposes a value to a web page, to the popup, or to a
 * log. Every inbound message is decoded (`wire.ts`) before anything acts on
 * it; one that does not decode is answered `bad_message`.
 */
import {
  browserFillPorts,
  browserSitePorts,
  runtimeSender,
  signalOutcome,
} from "@/lib/fill/browser-ports";
import { FILL_COMMAND } from "@/lib/fill/protocol";
import { createFillService } from "@/lib/fill/service";
import { fillRequest, pairRequest } from "@/lib/fill/wire";
import { createSiteRegistry } from "@/lib/sites/sites";

export default defineBackground(() => {
  const fill = createFillService(browserFillPorts());
  const sites = createSiteRegistry(browserSitePorts());
  const failed = { error: "fill_failed" };

  // A grant the person took back in the browser's own settings switches its
  // site off here too: the guard's registration goes with it.
  browser.permissions.onRemoved.addListener(() => {
    void sites.reconcile();
  });
  browser.runtime.onStartup.addListener(() => {
    void sites.reconcile();
  });

  // The keyboard command is a gesture outside the page.
  browser.commands.onCommand.addListener((command) => {
    if (command !== FILL_COMMAND) return;
    void fill
      .trigger("command")
      .then(({ outcome }) => signalOutcome(outcome))
      .catch(() => signalOutcome("fill_failed"));
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "opensesame.fill") {
      const request = fillRequest.safeParse(message);
      if (!request.success) {
        sendResponse({ error: "bad_message" });
        return undefined;
      }
      fill
        .handle(request.data, runtimeSender(sender))
        .then(sendResponse, () => sendResponse(failed));
      return true;
    }
    if (message?.type === "opensesame.fill.pair") {
      if (!pairRequest.safeParse(message).success) return undefined;
      fill
        .pairFrom(runtimeSender(sender))
        .then(sendResponse, () => sendResponse(failed));
      return true;
    }
    return undefined;
  });
});
