/**
 * Extension background: Host API + client-core sync cursor + optional daemon.
 * Never exposes getSecret to webpages.
 */
import { installSecurityBroker } from "@opensesame/app-core/browser/security/runtime.js";
import { openFromRest, sealForRest } from "@opensesame/browser-at-rest";
import { createCursor, persistSealedStore } from "@opensesame/client-core";
import { browserGrants, browserPages, closeRunTab } from "../runner/browser";
import {
  createGuardedHealthClient,
  readGuardedHealth,
} from "../runner/guarded-health";
import { connector } from "../runner/host";
import { resolveHostBase } from "../runner/host-base";
import { runnerListener } from "../runner/security-listener";
import { isOwnPage } from "../runner/sender";
import { createRunnerService } from "../runner/service";
import { RunnerSettings } from "../runner/settings";
import { SealedKv, browserStore } from "../runner/store";
import { RunnerVault } from "../runner/vault";

/** The alarm that wakes the runner: a service worker does not stay up to poll. */
const RUNNER_ALARM = "opensesame.runner.poll";

export default defineBackground(() => {
  const security = installSecurityBroker(browser.runtime);
  const cursor = createCursor("extension-device");
  const kv = new SealedKv(browserStore());
  const settings = new RunnerSettings(kv);
  const runner = createRunnerService({
    settings,
    vault: new RunnerVault(kv),
    grants: browserGrants(),
    pagesFor: browserPages(settings),
    closePage: closeRunTab,
    connect: connector(settings, resolveHostBase),
  });
  void browser.alarms.create(RUNNER_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RUNNER_ALARM) void runner.tick().catch(() => undefined);
  });

  browser.runtime.onInstalled.addListener(() => {
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

  browser.runtime.onMessage.addListener(
    runnerListener(runner, security, (sender) =>
      isOwnPage(sender, browser.runtime.id, browser.runtime.getURL("")),
    ),
  );

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "opensesame.health") {
      void (async () => {
        try {
          const permit = message.securityPermit;
          if (
            !isOwnPage(
              sender,
              browser.runtime.id,
              browser.runtime.getURL(""),
            ) ||
            !(await security.allows(permit))
          ) {
            sendResponse({ error: "vault_locked" });
            return;
          }
          const check = async () => {
            if (!(await security.allows(permit)))
              throw new Error("vault_locked");
          };
          const result = await readGuardedHealth(
            check,
            () => resolveHostBase({ authorize: check }),
            (hostBase) => createGuardedHealthClient(hostBase, check),
          );
          sendResponse({ ...result, cursor });
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
