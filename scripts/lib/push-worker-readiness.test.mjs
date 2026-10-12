import { afterEach, describe, expect, it, vi } from "vitest";
import { untilWorkerHeld } from "../../apps/pages/scripts/lib/push-worker-harness.mjs";

const script = "https://app.example/OpenSesame/sw-push.js";
const settled = {
  registrations: 1,
  active: `${script}?r=1`,
  activeState: "activated",
  controller: script,
  installing: null,
  waiting: null,
};

afterEach(() => vi.useRealTimers());

describe("browser worker takeover readiness", () => {
  it("outwaits claimed-but-activating and subsequent same-variant retry slots", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ...settled, activeState: "activating" })
      .mockResolvedValueOnce({ ...settled, installing: `${script}?r=2` })
      .mockResolvedValueOnce({ ...settled, waiting: `${script}?r=2` })
      .mockResolvedValue(settled);
    const done = vi.fn();
    const held = untilWorkerHeld(
      { evaluate: read, url: () => script },
      "/OpenSesame/",
      script,
      "push worker should settle",
    ).then(done);
    await vi.advanceTimersByTimeAsync(300);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    await held;
    expect(read).toHaveBeenCalledTimes(4);
    expect(done).toHaveBeenCalledWith(settled);
  });

  it.each([
    { ...settled, registrations: 2 },
    { ...settled, controller: "https://other.example/OpenSesame/sw-push.js" },
    { ...settled, controller: "https://app.example/OpenSesame/sw.js" },
    { ...settled, waiting: `${script}?r=2` },
  ])(
    "still fails an unsettled or competing scope at the original bound",
    async (state) => {
      vi.useFakeTimers();
      const read = vi.fn().mockResolvedValue(state);
      const outcome = untilWorkerHeld(
        { evaluate: read, url: () => script },
        "/OpenSesame/",
        script,
        "push worker should settle",
        300,
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(300);
      expect(await outcome).toEqual(
        new Error(`push worker should settle: ${JSON.stringify(state)}`),
      );
      expect(read).toHaveBeenCalledTimes(2);
    },
  );
});
