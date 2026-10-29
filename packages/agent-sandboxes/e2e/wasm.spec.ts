import { expect, test } from "@playwright/test";
import { WasmRelayProvider, startVirtualNetworkRelay } from "../src/index.js";
import {
  PEPPER,
  expectNewPasswordAccepted,
  runtimeForDriver,
} from "./harness.js";
import { MockResetSite } from "./mock-site.js";

test("full reset in the WASM DOM driver over a virtualized network", async () => {
  const site = new MockResetSite();
  await site.start(true);
  const relay = await startVirtualNetworkRelay({ token: "vnet-e2e-token" });
  try {
    const provider = new WasmRelayProvider({
      relayUrl: relay.url,
      relayToken: "vnet-e2e-token",
    });
    const sandbox = await provider.allocate({ origin: site.origin });
    expect(sandbox.provider).toBe("wasm-relay");
    const runtime = runtimeForDriver(sandbox.browser, site, true);
    const parked = await runtime.runner.start(runtime.initial);
    expect(parked.status).toBe("awaiting_human");
    expect(runtime.challenges).toEqual(["captcha"]);
    const finished = await runtime.runner.resumeAfterHuman(parked);
    expect(finished.status).toBe("succeeded");
    expect(site.submissions).toBe(1);
    await expectNewPasswordAccepted(runtime.custody, site);
    const journalText = JSON.stringify(await runtime.store.load("run-1"));
    expect(journalText).not.toContain(PEPPER);
    await sandbox.close();
  } finally {
    await relay.close();
    await site.stop();
  }
});
