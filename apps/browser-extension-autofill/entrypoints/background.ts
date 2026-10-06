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
/**
 * The companion's background (ADR 0150 §6.4, §7): fill by reference, started
 * only by a gesture on this extension's own UI, only on sites a person
 * switched on. Never exposes a value to a web page, to the popup, or to a
 * log. Every inbound message is decoded (`wire.ts`) before anything acts on
 * it; one that does not decode is answered `bad_message`.
 */
import { installSecurityBroker } from "@opensesame/app-core/browser/security/runtime.js";

export default defineBackground(() => {
  const security = installSecurityBroker(browser.runtime);
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
    void security
      .allows()
      .then((allowed) =>
        allowed ? fill.trigger("command") : { outcome: "vault_locked" },
      )
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
      const decoded = request.data;
      const authorize = () =>
        security.allows(
          decoded.op === "value" ? undefined : decoded.securityPermit,
        );
      void (async () => {
        if (decoded.op !== "value" && !(await authorize())) {
          sendResponse({ error: "vault_locked" });
          return;
        }
        const reply = await fill.handle(
          decoded,
          runtimeSender(sender),
          authorize,
        );
        if (decoded.op !== "value" && !(await authorize())) {
          sendResponse({ error: "vault_locked" });
          return;
        }
        sendResponse(reply);
      })().catch(() => sendResponse(failed));
      return true;
    }
    if (message?.type === "opensesame.fill.pair") {
      const request = pairRequest.safeParse(message);
      if (!request.success) return undefined;
      void (async () => {
        if (!(await security.allows(request.data.securityPermit))) {
          sendResponse({ error: "vault_locked" });
          return;
        }
        const reply = await fill.pairFrom(runtimeSender(sender));
        if (!(await security.allows(request.data.securityPermit))) {
          sendResponse({ error: "vault_locked" });
          return;
        }
        sendResponse(reply);
      })().catch(() => sendResponse(failed));
      return true;
    }
    return undefined;
  });
});
