/**
 * Extension background: Host API + client-core sync cursor + optional daemon.
 * Never exposes getSecret to webpages.
 */
import { createApiClient } from "@opensesame/api-client";
import { openFromRest, sealForRest } from "@opensesame/browser-at-rest";
import { createCursor, persistSealedStore } from "@opensesame/client-core";
import { browserGrants, browserPages, closeRunTab } from "../runner/browser";
import { connector } from "../runner/host";
import { resolveHostBase } from "../runner/host-base";
import { type MessageSender, isOwnPage } from "../runner/sender";
import {
  type RunnerService,
  type RunnerStatus,
  createRunnerService,
} from "../runner/service";
import { RunnerSettings } from "../runner/settings";
import { SealedKv, browserStore } from "../runner/store";
import { RunnerVault } from "../runner/vault";

/** The alarm that wakes the runner: a service worker does not stay up to poll. */
const RUNNER_ALARM = "opensesame.runner.poll";

/** What the options page asks of the runner. */
interface RunnerMessage {
  type?: string;
  origin?: string;
}

/** What the runner answers: a result word, or that it could not. */
interface RunnerReply {
  result?: string;
  error?: string;
}

/** Only this extension's own pages may ask the runner anything (`runner/sender.ts`). */
function fromOwnPage(sender: MessageSender): boolean {
  return isOwnPage(sender, browser.runtime.id, browser.runtime.getURL(""));
}

/**
 * The runner's messages, answered only to this extension's own pages. They are
 * handled by a listener of their own so the health listener's contract (answer
 * or pass) is untouched; a message that is not the runner's is passed on.
 */
function runnerListener(runner: RunnerService) {
  return (
    message: RunnerMessage | undefined,
    sender: MessageSender,
    sendResponse: (response: RunnerReply | RunnerStatus) => void,
  ) => {
    if (message?.type === "opensesame.runner.status") {
      if (!fromOwnPage(sender)) return undefined;
      void runner
        .status()
        .then(sendResponse, () =>
          sendResponse({ error: "runner_unavailable" }),
        );
      return true;
    }
    if (message?.type === "opensesame.runner.arm") {
      if (!fromOwnPage(sender)) return undefined;
      void runner.arm(String(message.origin ?? "")).then(
        (result) => {
          if (result === "armed") void runner.tick().catch(() => undefined);
          sendResponse({ result });
        },
        () => sendResponse({ error: "runner_unavailable" }),
      );
      return true;
    }
    if (message?.type === "opensesame.runner.disarm") {
      if (!fromOwnPage(sender)) return undefined;
      void runner.disarm(String(message.origin ?? "")).then(
        () => sendResponse({ result: "disarmed" }),
        () => sendResponse({ error: "runner_unavailable" }),
      );
      return true;
    }
  };
}

export default defineBackground(() => {
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

  browser.runtime.onMessage.addListener(runnerListener(runner));

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
