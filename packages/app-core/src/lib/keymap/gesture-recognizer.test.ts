import { describe, expect, it } from "vitest";
import {
  RECOGNIZER,
  SHAKE,
  type TouchSession,
  beginSession,
  createShakeDetector,
  fingerDown,
  fingerMove,
  finish,
  swipeInProgress,
} from "./gesture-recognizer.js";

type Move = readonly [dx: number, dy: number];

/** Two fingers 80px apart, landing together and moving by `by` each. */
function pair(by: readonly [Move, Move], landGap = 0): TouchSession {
  const session = beginSession(0);
  fingerDown(session, 1, { x: 100, y: 300 }, 0);
  fingerDown(session, 2, { x: 180, y: 300 }, landGap);
  fingerMove(session, 1, { x: 100 + by[0][0], y: 300 + by[0][1] });
  fingerMove(session, 2, { x: 180 + by[1][0], y: 300 + by[1][1] });
  return session;
}

const together = (dx: number, dy: number): readonly [Move, Move] => [
  [dx, dy],
  [dx, dy],
];

describe("two fingers swiping", () => {
  it.each([
    [-90, 0, "two-finger-swipe-left"],
    [90, 0, "two-finger-swipe-right"],
    [0, -90, "two-finger-swipe-up"],
    [0, 90, "two-finger-swipe-down"],
  ] as const)("reads (%i, %i) as %s", (dx, dy, gesture) => {
    expect(finish(pair(together(dx, dy)), 200)).toBe(gesture);
  });

  it("tolerates a little wander across the axis", () => {
    expect(finish(pair(together(90, RECOGNIZER.swipeOffAxis)), 200)).toBe(
      "two-finger-swipe-right",
    );
    expect(
      finish(pair(together(90, RECOGNIZER.swipeOffAxis + 20)), 200),
    ).toBeNull();
  });

  it("needs the distance, and not too slow a drag", () => {
    expect(finish(pair(together(RECOGNIZER.swipeMin - 10, 0)), 200)).toBeNull();
    expect(finish(pair(together(90, 0)), RECOGNIZER.swipeMaxMs + 1)).toBeNull();
  });

  it("needs both fingers to go the same way", () => {
    expect(
      finish(
        pair([
          [140, 0],
          [0, 0],
        ]),
        200,
      ),
    ).toBeNull();
    expect(
      finish(
        pair([
          [90, 0],
          [-90, 0],
        ]),
        200,
      ),
    ).toBeNull();
  });

  it("is not a swipe when the fingers pinch", () => {
    expect(
      finish(
        pair([
          [60, 0],
          [140, 0],
        ]),
        200,
      ),
    ).toBeNull();
  });

  it("is claimed early, once the drag is sure", () => {
    expect(swipeInProgress(pair(together(4, 0)))).toBeNull();
    expect(swipeInProgress(pair(together(RECOGNIZER.claimSlop + 4, 0)))).toBe(
      "two-finger-swipe-right",
    );
    expect(
      swipeInProgress(pair(together(0, -(RECOGNIZER.claimSlop + 4)))),
    ).toBe("two-finger-swipe-up");
    expect(
      swipeInProgress(
        pair([
          [20, 0],
          [-20, 0],
        ]),
      ),
    ).toBeNull();
  });
});

describe("two fingers tapping", () => {
  it("is a tap when neither moved and both lifted quickly", () => {
    expect(finish(pair(together(2, 3)), 120)).toBe("two-finger-tap");
  });

  it("is not a tap when held, or when they wandered", () => {
    expect(finish(pair(together(2, 3)), RECOGNIZER.tapMaxMs + 1)).toBeNull();
    expect(finish(pair(together(RECOGNIZER.tapSlop + 6, 0)), 120)).toBeNull();
  });
});

describe("what is never a gesture", () => {
  it("ignores a single finger", () => {
    const session = beginSession(0);
    fingerDown(session, 1, { x: 100, y: 300 }, 0);
    fingerMove(session, 1, { x: 300, y: 300 });
    expect(finish(session, 200)).toBeNull();
    expect(swipeInProgress(session)).toBeNull();
  });

  it("voids a touch with a third finger", () => {
    const session = pair(together(90, 0));
    fingerDown(session, 3, { x: 250, y: 300 }, 40);
    expect(finish(session, 200)).toBeNull();
  });

  it("voids a pair whose second finger landed late", () => {
    expect(
      finish(pair(together(90, 0), RECOGNIZER.landMs + 1), 400),
    ).toBeNull();
  });
});

type Sample = { x: number; y: number; z: number; t: number };

/** A phone swung back and forth: alternating readings `swing` apart. */
function shake(
  start: number,
  jolts: number,
  spacing: number,
  swing = 40,
): Sample[] {
  const samples: Sample[] = [{ x: 0, y: 0, z: 9.8, t: start }];
  for (let i = 0; i < jolts; i++) {
    samples.push({
      x: i % 2 === 0 ? swing : -swing,
      y: 0,
      z: 9.8,
      t: start + (i + 1) * spacing,
    });
  }
  return samples;
}

function run(samples: readonly Sample[]): boolean[] {
  const detector = createShakeDetector();
  return samples.map((sample) => detector.push(sample));
}

describe("a shake", () => {
  it("is several hard jolts in quick succession", () => {
    const results = run(shake(0, SHAKE.hits, 150));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.at(-1)).toBe(true);
  });

  it("is not one bump, nor a handful of gentle ones", () => {
    expect(run(shake(0, 1, 150)).some(Boolean)).toBe(false);
    expect(run(shake(0, 6, 150, 4)).some(Boolean)).toBe(false);
  });

  it("is not jolts spread over many seconds", () => {
    expect(run(shake(0, 6, 700)).some(Boolean)).toBe(false);
  });

  it("counts one swing once, however many readings it spans", () => {
    expect(run(shake(0, SHAKE.hits - 1, 20)).some(Boolean)).toBe(false);
  });

  it("rests after a shake, then listens again", () => {
    const detector = createShakeDetector();
    const first = shake(0, SHAKE.hits, 150).map((s) => detector.push(s));
    expect(first.at(-1)).toBe(true);
    const during = shake(1_000, SHAKE.hits, 150).map((s) => detector.push(s));
    expect(during.some(Boolean)).toBe(false);
    const after = shake(10_000, SHAKE.hits, 150).map((s) => detector.push(s));
    expect(after.some(Boolean)).toBe(true);
  });

  it("forgets what it had seen when reset", () => {
    const detector = createShakeDetector();
    for (const sample of shake(0, SHAKE.hits - 1, 150)) detector.push(sample);
    detector.reset();
    const last = shake(600, 1, 150).map((s) => detector.push(s));
    expect(last.some(Boolean)).toBe(false);
  });
});
