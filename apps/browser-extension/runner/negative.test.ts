import { describe, expect, it } from "vitest";
import { type Rig, enqueue, rig } from "./test-support/rig";
import { RP } from "./test-support/site";

describe("runs the runner does not claim", () => {
  it("a run another person owns is never claimed", async () => {
    const r = await rig();
    r.host.openRun("run:theirs", RP, "principal:someone-else");
    const pending = enqueue(r, "run:theirs", {
      step: "navigate",
      url: `${RP}/x`,
    });
    const report = await r.runner.tick();
    expect(await pending).toBeNull();
    expect(r.host.claims).toBe(0);
    expect(report.driven).toEqual([]);
    expect(r.pagesOpened).toBe(0);
  });

  const missing: [string, Parameters<typeof rig>[0], string][] = [
    ["its origin is not armed", { armed: false }, "not_armed"],
    ["the browser holds no grant for its origin", { grant: false }, "no_grant"],
    [
      "no credential is held for its origin",
      { credential: false },
      "no_credential",
    ],
    [
      "no recovery key is pinned to back a candidate up to",
      { recovery: false },
      "no_recovery_key",
    ],
  ];
  for (const [name, options, reason] of missing) {
    it(`a run is not claimed when ${name}`, async () => {
      const r = await rig(options);
      r.host.openRun("run:1", RP);
      const pending = enqueue(r, "run:1", { step: "navigate", url: `${RP}/x` });
      const report = await r.runner.tick();
      expect(await pending).toBeNull();
      expect(r.host.claims).toBe(0);
      // With nothing armed the runner does not even ask the Host for runs.
      expect(report.skipped).toEqual(
        reason === "not_armed" ? [] : [{ runId: "run:1", reason }],
      );
      expect(r.pagesOpened).toBe(0);
    });
  }

  it("a run is not claimed when no private window can prove the login", async () => {
    const r = await rig();
    r.browser.privateAllowed = false;
    r.host.openRun("run:1", RP);
    const report = await r.runner.tick();
    expect(report.skipped[0]?.reason).toBe("no_private_context");
    expect(r.host.claims).toBe(0);
  });

  it("nothing is asked of the Host without a session or an armed origin", async () => {
    const noSession = await rig({ session: false });
    noSession.host.openRun("run:1", RP);
    expect((await noSession.runner.tick()).connected).toBe(false);
    expect(noSession.host.claims).toBe(0);
    const unarmed = await rig({ armed: false });
    unarmed.host.openRun("run:1", RP);
    expect((await unarmed.runner.tick()).connected).toBe(false);
  });

  it("an origin the runner will not drive is not claimed, even when armed and granted", async () => {
    const r = await rig();
    for (const origin of [
      "http://rp.example",
      "ftp://rp.example",
      "https://user:p@rp.example",
    ]) {
      r.host.openRun(`run:${origin}`, origin);
      await r.settings.arm(origin);
      r.granted.add(origin);
    }
    const report = await r.runner.tick();
    expect(report.driven).toEqual([]);
    expect(report.skipped.every((s) => s.reason === "origin_refused")).toBe(
      true,
    );
    expect(r.host.claims).toBe(0);
  });

  it("does not claim the next step when getRun names another origin", async () => {
    const r = await rig();
    const other = "https://other.example";
    await r.settings.arm(other);
    r.granted.add(other);
    await r.vault.putEntry({
      origin: other,
      username: "other",
      password: "other-secret",
    });
    r.host.openRun("run:1", RP);
    r.host.presentView = (view, read) =>
      read === 1 ? view : { ...view, id: "run:other", origin: other };
    const navigate = enqueue(r, "run:1", {
      step: "navigate",
      url: `${RP}/x`,
    });
    const submit = enqueue(r, "run:1", { step: "submit" }, 50);
    const report = await r.runner.tick();
    expect((await navigate)?.outcome).toBe("done");
    expect(await submit).toBeNull();
    expect(r.host.claims).toBe(1);
    expect(r.host.settled.map((row) => row.request.step)).toEqual(["navigate"]);
    expect(report.skipped).toContainEqual({
      runId: "run:1",
      reason: "origin_refused",
    });
  });

  it("stops with not_armed when the opened origin expires before the next claim", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    r.host.presentView = async (view, read) => {
      if (read > 1) await r.settings.arm(RP, -1);
      return view;
    };
    const navigate = enqueue(r, "run:1", {
      step: "navigate",
      url: `${RP}/x`,
    });
    const submit = enqueue(r, "run:1", { step: "submit" }, 50);
    const report = await r.runner.tick();
    expect((await navigate)?.outcome).toBe("done");
    expect(await submit).toBeNull();
    expect(r.host.claims).toBe(1);
    expect(report.skipped).toContainEqual({
      runId: "run:1",
      reason: "not_armed",
    });
  });

  it("an arm that ran out drives nothing and gives its grant back", async () => {
    const r = await rig();
    await r.settings.arm(RP, -1);
    r.host.openRun("run:1", RP);
    const report = await r.runner.tick();
    expect(report.driven).toEqual([]);
    expect(r.revoked).toEqual([RP]);
    expect(r.host.claims).toBe(0);
  });
});

describe("a person holding the page", () => {
  for (const [name, hold] of [
    ["asks for it", (r: Rig) => r.host.handOff("run:1")],
    ["is parked for", (r: Rig) => r.host.handOff("run:1", "awaiting_human")],
    ["takes it", (r: Rig) => r.host.takeControl("run:1")],
  ] as const) {
    it(`stops the runner claiming the moment a person ${name}`, async () => {
      const r = await rig();
      r.host.openRun("run:1", RP);
      const first = enqueue(
        r,
        "run:1",
        { step: "navigate", url: `${RP}/account/password` },
        5_000,
      );
      const ticking = r.runner.tick();
      expect((await first)?.outcome).toBe("done");
      hold(r);
      const second = enqueue(r, "run:1", {
        step: "wait_for",
        selector: "#new",
      });
      const report = await ticking;
      expect(await second).toBeNull();
      expect(r.host.settled).toHaveLength(1);
      expect(report.skipped.at(-1)?.reason).toMatch(
        /human_holds_page|not_driving/,
      );
      // The page is left exactly as the person will find it.
      expect(r.closedTabs).toEqual([]);
      expect(r.browser.main?.closed).toBe(false);
    });
  }

  it("a run that is already theirs is not started", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    r.host.takeControl("run:1");
    const report = await r.runner.tick();
    expect(report.skipped).toEqual([
      { runId: "run:1", reason: "human_holds_page" },
    ]);
    expect(r.host.claims).toBe(0);
  });
});

describe("steps the runner will not run", () => {
  it("an unknown step is refused: nothing is run and nothing is settled", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    const pending = enqueue(r, "run:1", {
      step: "teleport",
      to: "https://evil.example",
    });
    const report = await r.runner.tick();
    expect(await pending).toBeNull();
    expect(report.refused).toBe(1);
    expect(r.host.settled).toEqual([]);
    expect(r.host.refused).toEqual([]);
    expect(r.browser.main?.path).toBe("about:blank");
  });

  it("a known step with a field it does not have is refused whole", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    const pending = enqueue(r, "run:1", {
      step: "fill_credential",
      reference: "current_password",
      selector: "#current",
      value: "hunter2",
    });
    const report = await r.runner.tick();
    expect(await pending).toBeNull();
    expect(report.refused).toBe(1);
    expect(r.host.settled).toEqual([]);
  });

  it("a navigation off the run's origin is a failure and the browser is not touched", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    const targets = [
      "https://evil.example/login",
      "http://rp.example/account/password",
      "https://rp.example.evil.example/",
      "https://rp.example:8443/",
      "javascript:alert(1)",
      "/relative",
    ];
    const [outcomes] = await Promise.all([
      Promise.all(
        targets.map((url) =>
          enqueue(r, "run:1", { step: "navigate", url }, 5_000),
        ),
      ),
      r.runner.tick(),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ outcome: "failed", error: "navigation" });
    }
    expect(r.browser.main?.path).toBe("about:blank");
    // The browser was never even asked to load any of them.
    expect(r.browser.main?.requested).toEqual([]);
  });

  it("a ceremony capture is answered as a failure, never as something sealed", async () => {
    const r = await rig();
    r.host.openRun("run:1", RP);
    const pending = enqueue(r, "run:1", {
      step: "capture_credential",
      slot: "client_secret",
      selector: "#secret",
      recipient: "host-key",
    });
    await r.runner.tick();
    expect(await pending).toEqual({ outcome: "failed", error: "transport" });
  });
});
