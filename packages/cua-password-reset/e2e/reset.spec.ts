import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FileCheckpointJournal } from "../src/index.js";
import { MockResetSite, type Challenge } from "./mock-site.js";
import { PEPPER, runtime } from "./runtime.js";

let site: MockResetSite;
test.beforeEach(async () => {
  site = new MockResetSite();
  await site.start();
});
test.afterEach(async () => {
  await site.stop();
});

test("CDP link flow replays without a model and keeps pepper out of checkpoints", async ({ page }) => {
  const current = runtime(page, site);
  const result = await current.runner.start(current.initial);
  expect(result.status).toBe("succeeded");
  expect(site.submissions).toBe(1);
  await current.custody.withPassword(async (password) => {
    expect(site.accepts(password)).toBe(true);
  });
  expect(JSON.stringify(await current.journal.events("run-1"))).not.toContain(PEPPER);
});

test("exact-form proxy substitutes the real candidate at the one declared field", async ({ page }) => {
  const current = runtime(page, site, null, undefined, true);
  expect((await current.runner.start(current.initial)).status).toBe("succeeded");
  await current.custody.withPassword(async (password) => {
    expect(site.accepts(password)).toBe(true);
  });
});

test("drift stops before password submit", async ({ page }) => {
  site.driftForm();
  const current = runtime(page, site);
  expect((await current.runner.start(current.initial)).status).toBe("failed");
  expect(site.submissions).toBe(0);
});

test("a lost submit response resumes by reconciliation, never another submit", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "cua-reset-e2e-"));
  try {
    const store = await FileCheckpointJournal.open(directory);
    const current = runtime(page, site, null, store);
    const execute = current.effects.execute;
    current.effects.execute = async (step, run, context) => {
      const receipt = await execute(step, run, context);
      if (step.primitive === "submit") throw new Error("Lost submit response");
      return receipt;
    };
    expect((await current.runner.start(current.initial)).status).toBe("reconciliation_required");
    expect(site.submissions).toBe(1);
    expect((await current.runner.resume("run-1")).status).toBe("reconciliation_required");
    expect(site.submissions).toBe(1);
    expect((await current.runner.reconcile("run-1")).status).toBe("succeeded");
    expect(site.submissions).toBe(1);
    for (const file of await import("node:fs/promises").then(({ readdir }) => readdir(directory)))
      expect(await readFile(join(directory, file), "utf8")).not.toContain(PEPPER);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an authoritative failed verification compensates after a failed submit", async ({ page }) => {
  site.transformPasswords();
  const current = runtime(page, site, null, undefined, true);
  expect((await current.runner.start(current.initial)).status).toBe("reconciliation_required");
  expect((await current.runner.reconcile("run-1")).status).toBe("failed");
  expect(site.accepts("old-password")).toBe(true);
});

for (const challenge of ["captcha", "mail_code", "totp", "passkey"] as const) {
  test(`${challenge} pauses for a person and resumes with fresh state`, async ({ page }) => {
    site.setChallenge(challenge as Challenge);
    const current = runtime(page, site, challenge);
    expect((await current.runner.start(current.initial)).status).toBe("awaiting_human");
    expect(current.challenges).toEqual([challenge]);
    expect(site.submissions).toBe(0);
    expect((await current.runner.resumeAfterHuman("run-1")).status).toBe("succeeded");
    expect(site.submissions).toBe(1);
  });
}
