import { RunnerApiError } from "@opensesame/api-client";
import { describe, expect, it } from "vitest";
import { RECIPE, changePassword } from "./test-support/executor";
import { type Rig, enqueue, rig } from "./test-support/rig";
import { RP } from "./test-support/site";

describe("a backup that cannot be proven stops the run before the submit", () => {
  for (const [name, arrange] of [
    [
      "the Host refuses the blob",
      (r: Rig) => {
        r.host.rejectPushes = true;
      },
    ],
    [
      "the Host returns something else",
      (r: Rig) => {
        r.host.tamperOnRead = true;
      },
    ],
  ] as const) {
    it(`when ${name}`, async () => {
      const r = await rig();
      arrange(r);
      r.host.openRun("run:1", RP);
      const [walk] = await Promise.all([
        changePassword(r.host, "run:1", RECIPE),
        r.runner.tick(),
      ]);
      expect(walk.ended).toEqual({
        kind: "blocked",
        why: "backup_not_acknowledged",
      });
      const sealed = r.host.settled.find(
        (s) => s.request.step === "seal_candidate",
      );
      expect(sealed?.outcome).toEqual({ outcome: "sealed", backed_up: false });
      expect(walk.steps).not.toContain("submit");
      expect(r.site.submits).toEqual([]);
    });
  }
});

describe("a rejected or unprovable login is not a pass", () => {
  it("Indeterminate when the site shows neither marker", async () => {
    const r = await rig();
    r.site.render = (path, signedIn) =>
      path === "/login"
        ? '<html><body><form id="login"><input id="user" name="user" /><input id="pass" name="pass" type="password" /><button id="signin">Go</button></form></body></html>'
        : Object.getPrototypeOf(r.site).render.call(r.site, path, signedIn);
    r.host.openRun("run:1", RP);
    const [walk] = await Promise.all([
      changePassword(r.host, "run:1", RECIPE),
      r.runner.tick(),
    ]);
    const verified = r.host.settled.find(
      (s) => s.request.step === "verify_login",
    );
    expect(verified?.outcome).toEqual({
      outcome: "verified",
      verified: "Indeterminate",
    });
    expect(walk.ended.kind).toBe("reconcile");
    expect((await r.vault.getEntry(RP))?.password).not.toBe(r.site.password);
  });

  it("Indeterminate with no login profile to sign in with", async () => {
    const r = await rig({ loginProfile: false });
    r.host.openRun("run:1", RP);
    const [walk] = await Promise.all([
      changePassword(r.host, "run:1", RECIPE),
      r.runner.tick(),
    ]);
    const verified = r.host.settled.find(
      (s) => s.request.step === "verify_login",
    );
    expect(verified?.outcome).toEqual({
      outcome: "verified",
      verified: "Indeterminate",
    });
    expect(walk.ended.kind).toBe("reconcile");
    expect(r.browser.privateWindows.opened).toBe(0);
  });

  it("Rejected when the site refuses the credential", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    // The site silently keeps the old password, so the new one is refused at login.
    const submit = r.site.submit.bind(r.site);
    r.site.submit = (path, fields) => {
      if (path === "/account/password") {
        r.site.submits.push({ path, fields });
        return "/account/password/done";
      }
      return submit(path, fields);
    };
    const [walk] = await Promise.all([
      changePassword(r.host, "run:1", RECIPE),
      r.runner.tick(),
    ]);
    const verified = r.host.settled.find(
      (s) => s.request.step === "verify_login",
    );
    expect(verified?.outcome).toEqual({
      outcome: "verified",
      verified: "Rejected",
    });
    expect(walk.ended.kind).toBe("reconcile");
    // Never promoted: the vault still names the old password live.
    expect((await r.vault.getEntry(RP))?.password).toBe(
      "correct horse battery staple",
    );
  });
});

describe("the Host refusing a settle", () => {
  it("stops the run's pass instead of retrying what was refused", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    let attempts = 0;
    r.host.settle = async () => {
      attempts += 1;
      throw new RunnerApiError("runner_step_settle", 409, "not_the_claimant");
    };
    void enqueue(r, "run:1", {
      step: "navigate",
      url: `${RP}/account/password`,
    });
    const report = await r.runner.tick();
    expect(attempts).toBe(1);
    expect(report.settled).toBe(0);
  });

  it("a Host that is down is an error for the caller, never a settled step", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    r.host.settle = async () => {
      throw new Error("network down");
    };
    void enqueue(r, "run:1", {
      step: "navigate",
      url: `${RP}/account/password`,
    });
    await expect(r.runner.tick()).rejects.toThrow("network down");
  });
});

describe("a settle that never arrived", () => {
  it("is answered from what the step did, never by running it twice", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    const first = enqueue(
      r,
      "run:1",
      { step: "navigate", url: `${RP}/account/password` },
      5_000,
    );
    await Promise.all([first, r.runner.tick()]);
    // A submit is the step that must not run twice.
    const settle = r.host.settle.bind(r.host);
    r.host.settle = async () => {
      throw new Error("network down");
    };
    const dispatched = enqueue(
      r,
      "run:1",
      { step: "submit", selector: "#go" },
      5_000,
    );
    await expect(r.runner.tick()).rejects.toThrow("network down");
    expect(r.browser.main?.submitCount).toBe(1);
    // The lease lapses; the Host offers the step again; the Host is back.
    r.host.settle = settle;
    r.host.lapse("run:1");
    await Promise.all([dispatched, r.runner.tick()]);
    expect(r.browser.main?.submitCount).toBe(1);
    const settled = r.host.settled.filter(
      (row) => row.request.step === "submit",
    );
    expect(settled.map((row) => row.outcome)).toEqual([{ outcome: "done" }]);
  });
});

describe("a worker stopped in the middle of a submit", () => {
  it("does not press it again when the step is claimed anew", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    // The previous worker marked step 0 and was stopped before it answered.
    await r.settings.markPending("run:1", 0);
    const dispatched = enqueue(
      r,
      "run:1",
      { step: "submit", selector: "#go" },
      5_000,
    );
    await Promise.all([dispatched, r.runner.tick()]);
    expect(r.browser.main?.submitCount ?? 0).toBe(0);
    const settled = r.host.settled.filter(
      (row) => row.request.step === "submit",
    );
    expect(settled.map((row) => row.outcome)).toEqual([
      { outcome: "failed", error: "transport" },
    ]);
  });
});

describe("overlapping passes", () => {
  it("share one pass", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    const [a, b] = await Promise.all([r.runner.tick(), r.runner.tick()]);
    expect(a).toBe(b);
  });
});
