import { describe, expect, it } from "vitest";
import { stepChecks } from "./tutorial-measure.mjs";

const box = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

/** A healthy point step: the card clear of the ring, a pointer reaching the control. */
function pointStep(probe, overrides = {}) {
  return {
    kind: "point",
    step: 2,
    target: "shell.lock",
    degraded: false,
    notOnScreen: false,
    text: "Press this.",
    card: box(400, 300, 300, 120),
    ring: box(20, 20, 40, 40),
    control: box(26, 26, 28, 28),
    probe,
    go: box(600, 380, 80, 44),
    goDisabled: false,
    viewport: { width: 1280, height: 900 },
    ...overrides,
  };
}

const reach = (checks) =>
  checks.find(([, what]) => what.includes("reachable through the aperture"));

const onControl = {
  visible: true,
  x: 40,
  y: 40,
  hit: "button.icon-btn",
  onControl: true,
  onCard: false,
  onDim: false,
};

describe("the lit control's reach", () => {
  it("passes when a pointer at its visible centre reaches the control", () => {
    expect(reach(stepChecks(pointStep(onControl), { phone: false }))[0]).toBe(
      true,
    );
  });

  it.each([
    ["a toast over the control", { onControl: false, hit: "div.toast" }],
    [
      "the card",
      { onControl: false, onCard: true, hit: "section.coach__card" },
    ],
    ["the dim", { onControl: false, onDim: true, hit: "div.coach__dim" }],
  ])("fails when %s is what a pointer reaches", (_name, change) => {
    const [ok, what] = reach(
      stepChecks(pointStep({ ...onControl, ...change }), { phone: false }),
    );
    expect(ok).toBe(false);
    expect(what).toContain("shell.lock");
  });

  it("fails when the registry's control is not in the page at all", () => {
    const checks = stepChecks(pointStep(null), { phone: false });
    expect(
      checks.some(([ok, what]) => !ok && what.includes("shell.lock")),
    ).toBe(true);
  });

  it("fails when no part of the control is visible inside the aperture", () => {
    const checks = stepChecks(pointStep({ visible: false }), { phone: false });
    expect(checks.some(([ok]) => !ok)).toBe(true);
  });

  it("asks nothing of the control for a step that points at nothing", () => {
    const checks = stepChecks(
      pointStep(null, { kind: "say", target: "", ring: null, control: null }),
      { phone: false },
    );
    expect(checks.every(([ok]) => ok)).toBe(true);
  });
});
