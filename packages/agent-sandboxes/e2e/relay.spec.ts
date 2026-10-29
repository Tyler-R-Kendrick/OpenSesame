import { expect, test } from "@playwright/test";
import {
  LocalSandboxProvider,
  relayDriverOverWebSocket,
  startRelayServer,
} from "../src/index.js";
import {
  PEPPER,
  expectNewPasswordAccepted,
  runtimeForDriver,
} from "./harness.js";
import { MockResetSite } from "./mock-site.js";

const executable = process.env.AGENT_BROWSER;
if (!executable) throw new Error("AGENT_BROWSER is not configured");

test("full reset through the driver relay, with a takeover pause", async () => {
  const site = new MockResetSite();
  await site.start(true);
  const local = new LocalSandboxProvider({ executable });
  const hosted = await local.allocate({ origin: site.origin });
  const relay = await startRelayServer({
    token: "relay-e2e-token",
    driver: hosted.browser,
  });
  let relayClosedBrowser = false;
  let phase = "initialize";
  try {
    const driver = relayDriverOverWebSocket(relay.url, {
      token: "relay-e2e-token",
    });
    const runtime = runtimeForDriver(driver, site, true);
    phase = "start";
    const parked = await runtime.runner.start(runtime.initial);
    expect(parked.status).toBe("awaiting_human");
    expect(runtime.challenges).toEqual(["captcha"]);
    phase = "resume";
    const finished = await runtime.runner.resumeAfterHuman(parked);
    expect(finished.status).toBe("succeeded");
    expect(site.submissions).toBe(1);
    phase = "verify";
    await expectNewPasswordAccepted(runtime.custody, site);
    const journalText = JSON.stringify(await runtime.store.load("run-1"));
    expect(journalText).not.toContain(PEPPER);
    phase = "close";
    await driver.close();
    relayClosedBrowser = true;
  } catch (error) {
    process.stderr.write(`relay e2e failure phase: ${phase}\n`);
    throw error;
  } finally {
    await relay.close().catch(() => {});
    if (!relayClosedBrowser) await hosted.close().catch(() => {});
    await site.stop().catch(() => {});
  }
});
