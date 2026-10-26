/** The pinned public clock API must isolate expiry from subsequent consent. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { describe, it } from "vitest";

const require = createRequire(import.meta.url);
const playwright = createRequire(require.resolve("@playwright/test"));
const core = createRequire(playwright.resolve("playwright/package.json"));
// Playwright 1.64 bundles its generated clock primitive in coreBundle.
// Decode that exact shipped source; a packaging change must fail explicitly.
const bundle = fs.readFileSync(
  core.resolve("playwright-core/lib/coreBundle"),
  "utf8",
);
const clockModule = bundle
  .split("// packages/playwright-core/src/generated/clockSource.ts\n")[1]
  ?.split("\n// packages/playwright-core/")[0];
const sourceLiteral = clockModule?.match(/^\s+source = ('.*');$/m)?.[1];
assert.equal(typeof sourceLiteral, "string", "Pinned SDK exports clock source");
const clockSource = vm.runInNewContext(sourceLiteral, {}, { timeout: 1000 });
const module = { exports: {} };
vm.runInNewContext(clockSource, { module, console }, { timeout: 1000 });
const createClock = module.exports.createClock();
const BASE = 1_792_375_200_000;

function clockFixture() {
  let ticks = 0;
  let id = 0;
  const tasks = new Map();
  const { clock, api } = createClock({
    Date,
    performance: { now: () => ticks },
    setTimeout(callback, delay = 0) {
      tasks.set(++id, { callback, due: ticks + delay });
      return id;
    },
    clearTimeout: (timer) => tasks.delete(timer),
    setInterval: () => assert.fail("Unexpected native interval"),
    clearInterval() {},
  });
  clock.resume();
  return {
    clock,
    api,
    advance(to) {
      assert.ok(to >= ticks, "Independent native performance never rewinds");
      ticks = to;
    },
    fire() {
      const [key, task] = [...tasks].sort(
        (a, b) => a[1].due - b[1].due || a[0] - b[0],
      )[0];
      assert.ok(task.due <= ticks);
      tasks.delete(key);
      task.callback();
    },
  };
}
async function drainMicrotasks() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
async function pendingTimerInterleaving(fixture) {
  let first = 0;
  let second = 0;
  fixture.api.setTimeout(() => first++, 100);
  fixture.api.setTimeout(() => second++, 200);
  fixture.advance(100);
  fixture.fire();
  assert.equal(first, 1);
  fixture.advance(125);
  const issuedAt = fixture.api.Date.now();
  fixture.fire();
  await drainMicrotasks();
  const validationNow = fixture.api.Date.now();
  fixture.advance(225);
  fixture.fire();
  fixture.fire();
  await drainMicrotasks();
  assert.equal(second, 1, "Both real-time scheduled application timers run");
  return {
    backwardMilliseconds: issuedAt - validationNow,
    exceedsMaximum: issuedAt + 600_000 > validationNow + 600_000,
    timerCalls: [first, second],
  };
}

class DriverDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [BASE]));
  }
  static now() {
    return BASE;
  }
}
async function expiryBlock(fixture, failOperation = false) {
  const source = fs.readFileSync(
    new URL("./linear-recovery-browser-flows.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function expireRegistered(");
  const end = source.indexOf("\nasync function retryRegistered(", start);
  assert.ok(start >= 0 && end > start);
  const stop = new Error("Stop before the next consent protocol");
  const operationFailure = new Error("Owned expired-request failure");
  const authority = {
    calls: [{ path: "/oauth/token", form: { refresh_token: "owned-refresh" } }],
  };
  let observedFuture = false;
  const page = {
    clock: {
      setSystemTime: (date) => fixture.clock.setSystemTime(date.getTime()),
      setFixedTime: (date) => fixture.clock.setFixedTime(date.getTime()),
    },
    getByRole: () => ({
      async click() {
        assert.equal(fixture.api.Date.now(), BASE + 2 * 60 * 60 * 1000);
        observedFuture = true;
        if (failOperation) throw operationFailure;
      },
    }),
  };
  let afterRestore;
  const sandbox = {
    Date: DriverDate,
    revokeGrant: () => ({ refresh: "owned-refresh" }),
    incomplete: () => ({ waitFor: async () => {} }),
    beginLinearConsent: async () => {
      afterRestore = await pendingTimerInterleaving(fixture);
      throw stop;
    },
  };
  const expire = vm.runInNewContext(
    `${source.slice(start, end)}\nexpireRegistered`,
    sandbox,
    { timeout: 1000 },
  );
  await assert.rejects(
    expire(
      { harness: { setStep() {}, check: assert.ok } },
      page,
      "owned",
      authority,
      "old",
    ),
    (error) => error === (failOperation ? operationFailure : stop),
  );
  assert.equal(
    observedFuture,
    true,
    "Actual fixture operation sees expired time",
  );
  if (failOperation) afterRestore = await pendingTimerInterleaving(fixture);
  return afterRestore;
}

describe("Linear expiry clock isolation", () => {
  it("keeps the Playwright 1.64 system-clock restore from rewinding time", async () => {
    const fixture = clockFixture();
    fixture.clock.setSystemTime(BASE + 2 * 60 * 60 * 1000);
    fixture.clock.setSystemTime(BASE);
    assert.deepEqual(await pendingTimerInterleaving(fixture), {
      backwardMilliseconds: 0,
      exceedsMaximum: false,
      timerCalls: [1, 1],
    });
  });
  it("keeps fixed wall time stable while the same real-time timers progress", async () => {
    const fixture = clockFixture();
    fixture.clock.setFixedTime(BASE + 2 * 60 * 60 * 1000);
    fixture.clock.setFixedTime(BASE);
    assert.deepEqual(await pendingTimerInterleaving(fixture), {
      backwardMilliseconds: 0,
      exceedsMaximum: false,
      timerCalls: [1, 1],
    });
  });
  for (const failOperation of [false, true]) {
    it(`runs the actual expiry block and restores stable consent time after ${failOperation ? "failure" : "success"}`, async () => {
      const fixture = clockFixture();
      assert.deepEqual(await expiryBlock(fixture, failOperation), {
        backwardMilliseconds: 0,
        exceedsMaximum: false,
        timerCalls: [1, 1],
      });
    });
  }
});
