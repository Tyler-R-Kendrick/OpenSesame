import { expect, test } from "@playwright/test";
import {
  AgentBrowser,
  type Observation,
  createLocalSandbox,
} from "../src/index.js";
import { MockResetSite } from "./mock-site.js";
import { PEPPER, runtimeForDriver } from "./runtime.js";

function refFor(obs: Observation, kind: string, label: string): string {
  const field = obs.fields.find((f) => f.kind === kind && f.label === label);
  if (!field)
    throw new Error(
      `Missing ${kind} ${label} in ${JSON.stringify(obs.fields)}`,
    );
  return field.ref;
}

test("agent-browser 0.39 snapshot contract drives the local reset fixture", async () => {
  const site = new MockResetSite();
  await site.start();
  const browserConfig: ConstructorParameters<typeof AgentBrowser>[0] = {
    executable: process.env.AGENT_BROWSER ?? "agent-browser",
    session: `cua-contract-${crypto.randomUUID()}`,
    allowedDomains: ["127.0.0.1"],
  };
  if (process.env.AGENT_BROWSER_CHROME)
    browserConfig.browserExecutable = process.env.AGENT_BROWSER_CHROME;
  const browser = new AgentBrowser(browserConfig);
  try {
    await browser.open(`${site.origin}/reset`);
    const initial = await browser.snapshot();
    expect(initial.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "email", label: "Email" }),
        expect.objectContaining({ kind: "button", label: "Send reset link" }),
      ]),
    );
    await browser.open(site.resetLink());
    const reset = await browser.snapshot();
    expect(reset.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "password", label: "New password" }),
        expect.objectContaining({ kind: "button", label: "Save password" }),
      ]),
    );
  } finally {
    await browser.close().catch(() => {});
    await site.stop();
  }
});

test("zero-provision local sandbox completes a full password reset via agent-browser", async () => {
  const site = new MockResetSite();
  await site.start();
  const sandbox = createLocalSandbox({ origin: site.origin });
  try {
    await sandbox.browser.open(`${site.origin}/reset`);
    const request = await sandbox.browser.snapshot();
    await sandbox.browser.open(site.resetLink());
    const password = await sandbox.browser.snapshot();
    const refs = {
      identify: refFor(request, "email", "Email"),
      request: refFor(request, "button", "Send reset link"),
      password: refFor(password, "password", "New password"),
      submit: refFor(password, "button", "Save password"),
    };
    await expect(sandbox.browser.open("https://evil.example/")).rejects.toThrow(
      /approved domains/u,
    );
    const current = runtimeForDriver(sandbox.browser, site, { refs });
    const result = await current.runner.start(current.initial);
    expect(result.status).toBe("succeeded");
    expect(site.submissions).toBe(1);
    expect(site.accepts("old-password")).toBe(false);
    await current.custody.withPassword(async (candidate) => {
      expect(site.accepts(candidate)).toBe(true);
    });
    expect(JSON.stringify(await current.journal.events("run-1"))).not.toContain(
      PEPPER,
    );
  } finally {
    await sandbox.close().catch(() => {});
    await site.stop();
  }
});

test("a second driver on the same sandbox session takes over, clears the challenge, and the run resumes", async () => {
  const site = new MockResetSite();
  await site.start();
  site.setChallenge("captcha");
  const sandbox = createLocalSandbox({ origin: site.origin });
  // The human's driver: a distinct AgentBrowser bound to the SAME session,
  // so it sees and drives the exact page the agent parked on.
  const humanConfig: ConstructorParameters<typeof AgentBrowser>[0] = {
    executable: process.env.AGENT_BROWSER ?? "agent-browser",
    session: sandbox.session,
    allowedDomains: [...sandbox.allowedDomains],
  };
  if (process.env.AGENT_BROWSER_CHROME)
    humanConfig.browserExecutable = process.env.AGENT_BROWSER_CHROME;
  const human = new AgentBrowser(humanConfig);
  try {
    const current = runtimeForDriver(sandbox.browser, site, {
      challenge: "captcha",
      takeoverResume: async () => {
        const page = await human.snapshot();
        await human.click(refFor(page, "button", "Challenge completed"));
      },
    });
    expect((await current.runner.start(current.initial)).status).toBe(
      "awaiting_human",
    );
    expect(current.challenges).toHaveLength(1);
    expect(site.submissions).toBe(0);
    expect((await current.runner.resumeAfterHuman("run-1")).status).toBe(
      "succeeded",
    );
    expect(site.submissions).toBe(1);
    await current.custody.withPassword(async (candidate) => {
      expect(site.accepts(candidate)).toBe(true);
    });
  } finally {
    await sandbox.close().catch(() => {});
    await site.stop();
  }
});
