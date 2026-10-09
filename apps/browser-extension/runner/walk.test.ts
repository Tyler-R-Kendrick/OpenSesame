import { beforeAll, describe, expect, it } from "vitest";
import { backupId, openBackup } from "./backup";
import { RECIPE, changePassword } from "./test-support/executor";
import { CURRENT, rig } from "./test-support/rig";
import { RP } from "./test-support/site";

async function walkRun(r: Awaited<ReturnType<typeof rig>>, runId = "run:1") {
  r.host.openRun(runId, RP);
  const [walk, report] = await Promise.all([
    changePassword(r.host, runId, RECIPE),
    r.runner.tick(),
  ]);
  return { walk, report };
}

describe("a full change-password recipe walk through the runner", () => {
  let preparedRig: Awaited<ReturnType<typeof rig>>;
  beforeAll(async () => {
    // Provision the real 3072-bit recovery key and sealed vault as setup.
    // The recipe still performs real encryption, backup and promotion.
    preparedRig = await rig();
  });

  it("rotates the site's password end to end", async () => {
    const r = preparedRig;
    const { walk, report } = await walkRun(r);

    expect(walk.ended).toEqual({ kind: "completed" });
    expect(walk.steps).toEqual([
      "navigate",
      "wait_for",
      "generate_candidate",
      "seal_candidate",
      "fill_credential",
      "fill_credential",
      "fill_credential",
      "assert_present",
      "submit",
      "verify_login",
      "promote_candidate",
    ]);
    expect(report.settled).toBe(walk.steps.length);
    expect(report.refused).toBe(0);

    // The site accepted exactly one change, typed by the runner: the current
    // password in the current field, the candidate in both of the others.
    const change = r.site.submits.find((s) => s.path === "/account/password");
    expect(change?.fields.current).toBe(CURRENT);
    expect(change?.fields.new).toBe(change?.fields.confirm);
    expect(change?.fields.new).not.toBe(CURRENT);
    expect(r.site.password).toBe(change?.fields.new);

    // The vault now names the candidate live, and keeps the old one.
    const entry = await r.vault.getEntry(RP);
    expect(entry?.password).toBe(r.site.password);
    expect(entry?.previous).toBe(CURRENT);
  });

  it("never lets a credential into anything it settles", async () => {
    const r = await rig();
    const { walk } = await walkRun(r);
    const candidate = r.site.password;
    expect(walk.ended.kind).toBe("completed");
    expect(candidate).not.toBe(CURRENT);
    for (const secret of [CURRENT, candidate]) {
      expect(r.host.leaks(secret)).toBe(false);
    }
    // And nothing the Host was ever sent names a value: only references.
    const sent = JSON.stringify(r.host.settled.map((row) => row.request));
    expect(sent).not.toContain(candidate);
    expect(sent).not.toContain(CURRENT);
    expect(r.host.refused).toEqual([]);
  });

  it("backs the candidate up where only the recovery key can open it", async () => {
    const r = await rig();
    const { walk } = await walkRun(r);
    const handle = walk.handle ?? "";
    const stored = r.host.blobs.get(backupId(handle));
    expect(stored).toBeDefined();
    // The Host's copy is ciphertext: the password is nowhere in it.
    const text = new TextDecoder().decode(stored);
    expect(text).not.toContain(r.site.password);
    // The person's key opens it to exactly the password the site now holds.
    expect(await openBackup(r.privateKey, stored ?? new Uint8Array())).toBe(
      r.site.password,
    );
  });

  it("proves the login in a private window and closes it", async () => {
    const r = await rig();
    const { walk } = await walkRun(r);
    expect(walk.ended.kind).toBe("completed");
    expect(r.browser.privateWindows).toEqual({ opened: 1, closed: 1 });
    const login = r.site.submits.find((s) => s.path === "/login");
    expect(login?.fields.pass).toBe(r.site.password);
    expect(login?.fields.user).toBe(r.site.username);
  });

  it("gives the page and the grant back when the run ends", async () => {
    const r = await rig();
    await walkRun(r);
    // The run closed, so the next pass finds it finished and cleans up.
    await r.runner.tick();
    expect(r.closedTabs).toEqual([7]);
    expect(r.revoked).toEqual([RP]);
    expect(await r.settings.isArmed(RP)).toBe(false);
    expect((await r.settings.active()).size).toBe(0);
  });
});
