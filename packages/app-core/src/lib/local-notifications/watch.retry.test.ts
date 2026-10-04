/**
 * What the watcher does after a read fails (ADR 0162): it tries again, later
 * each time, a few times and no more, and a good read starts the count over.
 */

import { describe, expect, it } from "vitest";
import { READ_RETRY_DELAYS_MS } from "../device-inbox.js";
import { REF_A, rig, row } from "./watch-rig.js";

/** The timer the watcher most recently asked for, if it is still live. */
const pending = (r: ReturnType<typeof rig>) =>
  r.timers.filter((timer) => timer.live).at(-1);

describe("a read that fails", () => {
  it("is tried again after a delay that grows, and the marks come back when it works", async () => {
    const r = rig();
    r.state.unreadable = true;
    r.state.rows = [row(REF_A)];
    await r.settle();
    expect(r.calls).toEqual(["inApp:null", "tab:0", "close"]);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timer = pending(r);
      delays.push(timer?.ms ?? -1);
      timer?.action();
      await r.settle();
    }
    expect(delays).toEqual(READ_RETRY_DELAYS_MS.slice(0, 2));
    r.state.unreadable = false;
    pending(r)?.action();
    await r.settle();
    expect(r.calls).toContain("inApp:1");
    await r.stop();
  });

  it("is tried no more times than there are delays", async () => {
    const r = rig();
    r.state.unreadable = true;
    await r.settle();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const timer = pending(r);
      if (!timer) break;
      timer.action();
      await r.settle();
    }
    // The first read, and one retry per delay: then it waits to be told.
    expect(r.state.reads).toBe(1 + READ_RETRY_DELAYS_MS.length);
    expect(pending(r)).toBeUndefined();
    // Told, it reads again.
    await r.fire("change");
    expect(r.state.reads).toBe(2 + READ_RETRY_DELAYS_MS.length);
    await r.stop();
  });

  it("starts the count over once a read works", async () => {
    const r = rig();
    r.state.unreadable = true;
    await r.settle();
    pending(r)?.action();
    await r.settle();
    r.state.unreadable = false;
    pending(r)?.action();
    await r.settle();
    r.state.unreadable = true;
    await r.fire("change");
    // The first delay again, not the third.
    expect(pending(r)?.ms).toBe(READ_RETRY_DELAYS_MS[0]);
    await r.stop();
  });

  it("is not tried again once the watch has stopped", async () => {
    const r = rig();
    r.state.unreadable = true;
    await r.settle();
    await r.stop();
    expect(r.timers.every((timer) => !timer.live)).toBe(true);
  });
});
