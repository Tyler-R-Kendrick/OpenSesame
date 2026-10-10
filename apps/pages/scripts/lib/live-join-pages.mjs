/**
 * The pages verify:live-join walks in (ADR 0150): one per person, in the
 * engine of the browser it is opened in, served from a build on its origin,
 * watched for every peer connection, every copy and every error; and, on a
 * failure, each open page as it stood.
 */

import path from "node:path";
import {
  BROWSER_ICE_FAILED,
  allowFor,
  contextOptions,
  engineOf,
} from "./live-engines.mjs";
import {
  COPY_WATCH,
  WATCH_RTC,
  peerStates,
  probeChannels,
} from "./live-join-walk.mjs";

/**
 * The page helpers for one run. `named()` says which pair is walking now, so
 * a screenshot carries it; `passthrough` lists the loopback servers a page
 * may reach for real.
 */
export function livePages({ harness, origin, dist, out, passthrough, named }) {
  /** A person's page: `device` shapes the screen, `init` scripts run first. */
  async function device(
    browser,
    {
      init = [],
      origin: at = origin,
      dist: from = dist,
      device: screen,
      ...options
    } = {},
  ) {
    const engine = engineOf(browser);
    const made = await harness.newPage(browser, {
      ...options,
      device: contextOptions(engine, screen),
      origin: at,
      dist: from,
      passthrough,
    });
    const sockets = [];
    await allowFor(engine, made.context, made.page, at);
    await made.context.addInitScript(WATCH_RTC);
    await made.context.addInitScript(COPY_WATCH);
    for (const [script, arg] of init)
      await made.context.addInitScript(script, arg);
    made.page.on("websocket", (socket) => sockets.push(socket.url()));
    made.page.on("console", (message) => {
      const text = message.text().slice(0, 400);
      if (message.type() !== "error") {
        if (process.env.LIVE_CONSOLE) harness.record("console", text);
        return;
      }
      // Where it came from: WebKit names a failed resource only here.
      const where = message.location()?.url;
      harness.record(
        BROWSER_ICE_FAILED.test(text) ? "BROWSER-ICE" : "CONSOLE-ERROR",
        where ? `${text} (${where.slice(0, 200)})` : text,
      );
    });
    made.page.on("requestfailed", (request) =>
      harness.record(
        "request-failed",
        `${request.url().slice(0, 200)} ${request.failure()?.errorText ?? ""}`,
      ),
    );
    return { ...made, sockets, origin: at, dist: from, engine };
  }

  /** A screenshot, named for the pair walking. */
  async function shot(page, name) {
    const pair = named("").trim();
    const prefix = pair ? `${pair.replace(">", "-to-")}-` : "";
    await page.screenshot({ path: path.join(out, `${prefix}${name}.png`) });
  }

  /** Every RTCPeerConnection's configuration, as the page made it. */
  async function configs(page) {
    return (await page.evaluate(() => window.__rtcConfigs)).map((raw) =>
      JSON.parse(raw),
    );
  }

  /** On a failure, every open page of `browser` as it stood. */
  async function wreckage(browser, label) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const [at, page] of pages.entries())
      await page
        .screenshot({ path: path.join(out, `failed-${label}-${at + 1}.png`) })
        .catch(() => {});
    await probeChannels(pages);
    for (const [at, page] of pages.entries()) {
      const states = await peerStates(page).catch(() => null);
      harness.record(
        "FAILED-PAGE",
        `${label}-${at + 1} ${JSON.stringify(states)}`,
      );
    }
  }

  return { device, shot, configs, wreckage };
}
