import { expect, test } from "@playwright/test";
import { AgentBrowser } from "../src/index.js";
import { MockResetSite } from "./mock-site.js";

test("agent-browser 0.39 snapshot contract drives the local reset fixture", async () => {
  const site = new MockResetSite();
  await site.start();
  const browser = new AgentBrowser({
    executable: process.env.AGENT_BROWSER ?? "agent-browser",
    session: `cua-contract-${crypto.randomUUID()}`,
    allowedDomains: ["127.0.0.1"],
    secretFill: async () => { throw new Error("Secret fill is not used by this contract probe"); },
  });
  try {
    await browser.open(`${site.origin}/reset`);
    const initial = await browser.snapshot();
    expect(initial.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "email", label: "Email" }),
      expect.objectContaining({ kind: "button", label: "Send reset link" }),
    ]));
    await browser.open(site.resetLink());
    const reset = await browser.snapshot();
    expect(reset.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "password", label: "New password" }),
      expect.objectContaining({ kind: "button", label: "Save password" }),
    ]));
  } finally {
    await browser.close().catch(() => {});
    await site.stop();
  }
});
