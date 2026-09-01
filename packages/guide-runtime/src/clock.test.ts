import { describe, expect, it, vi } from "vitest";

import { createTestClock, systemGuideClock } from "./clock.js";

describe("systemGuideClock", () => {
  it("resolves on the deadline and clears the timer when the wait is abandoned", async () => {
    vi.useFakeTimers();
    try {
      const clock = systemGuideClock();
      const kept = new AbortController();
      let elapsed = false;
      void clock.after(250, kept.signal).then(() => {
        elapsed = true;
      });

      await vi.advanceTimersByTimeAsync(249);
      expect(elapsed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(elapsed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const abandoned = new AbortController();
      let abandonedElapsed = false;
      void clock.after(250, abandoned.signal).then(() => {
        abandonedElapsed = true;
      });
      expect(vi.getTimerCount()).toBe(1);

      abandoned.abort();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(abandonedElapsed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never settles for a signal that was already aborted", async () => {
    const clock = systemGuideClock();
    const controller = new AbortController();
    controller.abort();

    const winner = await Promise.race([
      clock.after(0, controller.signal).then(() => "deadline"),
      Promise.resolve("still pending"),
    ]);

    expect(winner).toBe("still pending");
  });
});

describe("createTestClock", () => {
  it("settles a deadline only once the clock has passed it", async () => {
    const clock = createTestClock();
    const controller = new AbortController();
    let elapsed = false;
    void clock.after(30_000, controller.signal).then(() => {
      elapsed = true;
    });

    expect(clock.pending()).toBe(1);
    await clock.advance(29_999);
    expect(elapsed).toBe(false);
    expect(clock.now()).toBe(29_999);

    await clock.advance(1);
    expect(elapsed).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it("disarms a deadline on abort and never settles it", async () => {
    const clock = createTestClock();
    const controller = new AbortController();
    let elapsed = false;
    void clock.after(30_000, controller.signal).then(() => {
      elapsed = true;
    });

    controller.abort();
    expect(clock.pending()).toBe(0);

    await clock.advance(60_000);
    expect(elapsed).toBe(false);
  });

  it("never settles for a signal that was already aborted", async () => {
    const clock = createTestClock();
    const controller = new AbortController();
    controller.abort();

    const deadline = clock.after(250, controller.signal).then(() => "deadline");
    expect(clock.pending()).toBe(0);

    await clock.advance(60_000);
    const winner = await Promise.race([
      deadline,
      Promise.resolve("still pending"),
    ]);
    expect(winner).toBe("still pending");
  });
});
