/**
 * What a pair of fingers did, and whether the phone was shaken (ADR 0164).
 * Pure: no DOM, no timers, no events — a shell feeds it touch points and
 * motion samples and asks which gesture, if any, they made. The numbers are
 * stated once, here, so the tests and the shell read the same ones.
 *
 * One finger is never read: it is the page's (tap, scroll, hold, a row swiped
 * for its menu). A third finger, a pinch, or a pair that did not land
 * together voids the touch, so a stray palm or a zoom is never a command.
 */
import type { GestureId } from "./gestures.js";

export const RECOGNIZER = {
  /** Distance the pair's midpoint must travel for a swipe. */
  swipeMin: 64,
  /** How far it may stray across the axis and still be straight. */
  swipeOffAxis: 44,
  /** A swipe that took longer is a considered drag, not a flick. */
  swipeMaxMs: 900,
  /** The second finger must land this soon after the first. */
  landMs: 180,
  /** A pair that lifts within this, hardly moved, is a tap. */
  tapMaxMs: 320,
  /** How far a finger may wander and still be tapping. */
  tapSlop: 16,
  /** A change in the gap between the fingers that makes it a pinch. */
  pinchSlop: 28,
  /** Midpoint travel after which a swipe is decided, so the page may claim it. */
  claimSlop: 12,
} as const;

export type Point = Readonly<{ x: number; y: number }>;

type Finger = { start: Point; at: Point; landedAt: number };

/** One touch, from the first finger down to the last finger up. */
export type TouchSession = {
  fingers: Map<number, Finger>;
  startedAt: number;
  /** Most fingers down at once. */
  peak: number;
  /** The gap between the first two fingers when the second landed. */
  gap: number | null;
  /** Something made this touch not a gesture: a third finger, a late second. */
  void: boolean;
};

export function beginSession(at: number): TouchSession {
  return { fingers: new Map(), startedAt: at, peak: 0, gap: null, void: false };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** A finger lands. */
export function fingerDown(
  session: TouchSession,
  id: number,
  point: Point,
  at: number,
): void {
  session.fingers.set(id, { start: point, at: point, landedAt: at });
  const down = session.fingers.size;
  session.peak = Math.max(session.peak, down);
  if (session.peak > 2) session.void = true;
  if (down === 2) {
    if (at - session.startedAt > RECOGNIZER.landMs) session.void = true;
    const [first, second] = [...session.fingers.values()];
    if (first && second) session.gap = distance(first.at, second.at);
  }
}

/** A finger moves. */
export function fingerMove(
  session: TouchSession,
  id: number,
  point: Point,
): void {
  const finger = session.fingers.get(id);
  if (finger) finger.at = point;
}

type Pair = readonly [Finger, Finger];

function pairOf(session: TouchSession): Pair | null {
  if (session.void || session.peak !== 2) return null;
  const [first, second] = [...session.fingers.values()];
  return first && second ? [first, second] : null;
}

function travel(finger: Finger): Point {
  return { x: finger.at.x - finger.start.x, y: finger.at.y - finger.start.y };
}

function midpointTravel(pair: Pair): Point {
  const a = travel(pair[0]);
  const b = travel(pair[1]);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The gap between the fingers now, against when the second landed. */
function pinched(session: TouchSession, pair: Pair): boolean {
  if (session.gap === null) return false;
  const now = distance(pair[0].at, pair[1].at);
  return Math.abs(now - session.gap) > RECOGNIZER.pinchSlop;
}

/** Both fingers went the same way along `axis`, neither merely along for the ride. */
function together(
  pair: Pair,
  axis: "x" | "y",
  sign: number,
  min: number,
): boolean {
  return pair.every((finger) => travel(finger)[axis] * sign >= min / 2);
}

type Direction = "left" | "right" | "up" | "down";

function swipeDirection(mid: Point, min: number): Direction | null {
  const across = (axis: number, other: number) =>
    Math.abs(axis) >= min && Math.abs(other) <= RECOGNIZER.swipeOffAxis;
  if (across(mid.x, mid.y)) return mid.x < 0 ? "left" : "right";
  if (across(mid.y, mid.x)) return mid.y < 0 ? "up" : "down";
  return null;
}

const SWIPES = {
  left: "two-finger-swipe-left",
  right: "two-finger-swipe-right",
  up: "two-finger-swipe-up",
  down: "two-finger-swipe-down",
} as const satisfies Readonly<Record<Direction, GestureId>>;

/** Which way the pair went, if both went it and the gap held. */
function directionOf(
  session: TouchSession,
  pair: Pair,
  min: number,
): Direction | null {
  if (pinched(session, pair)) return null;
  const direction = swipeDirection(midpointTravel(pair), min);
  if (direction === null) return null;
  const axis = direction === "left" || direction === "right" ? "x" : "y";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  return together(pair, axis, sign, min) ? direction : null;
}

/**
 * The swipe a pair is already making, once it has travelled far enough to be
 * sure of — so the page can claim the drag (cancel its scroll) while it is
 * still under the fingers. Null until then, for anything not a swipe, and
 * once the drag has outlasted a swipe.
 */
export function swipeInProgress(
  session: TouchSession,
  at: number,
): GestureId | null {
  const pair = pairOf(session);
  if (pair === null || session.fingers.size !== 2) return null;
  // A drag slower than a swipe is a scroll: the claim is let go of, so it is
  // never stranded between a gesture it will not be and a scroll it was denied.
  if (at - session.startedAt > RECOGNIZER.swipeMaxMs) return null;
  const direction = directionOf(session, pair, RECOGNIZER.claimSlop);
  return direction === null ? null : SWIPES[direction];
}

function isTap(session: TouchSession, pair: Pair, at: number): boolean {
  if (at - session.startedAt > RECOGNIZER.tapMaxMs) return false;
  if (pinched(session, pair)) return false;
  return pair.every((finger) => {
    const moved = travel(finger);
    return Math.hypot(moved.x, moved.y) <= RECOGNIZER.tapSlop;
  });
}

/**
 * The gesture the touch made, asked when the last finger lifts. A swipe is
 * judged by its midpoint, a tap by how little either finger moved.
 */
export function finish(session: TouchSession, at: number): GestureId | null {
  const pair = pairOf(session);
  if (pair === null) return null;
  if (isTap(session, pair, at)) return "two-finger-tap";
  if (at - session.startedAt > RECOGNIZER.swipeMaxMs) return null;
  const direction = directionOf(session, pair, RECOGNIZER.swipeMin);
  return direction === null ? null : SWIPES[direction];
}

/** One reading of the phone's accelerometer, gravity included. */
export type MotionSample = Readonly<{
  x: number;
  y: number;
  z: number;
  t: number;
}>;

export const SHAKE = {
  /** How hard one jolt must be, as the change between two readings (m/s²). */
  jolt: 22,
  /** Jolts closer together than this are one swing, not two. */
  gapMs: 90,
  /** Jolts needed, inside `windowMs`, for a shake. */
  hits: 4,
  windowMs: 1_000,
  /** After a shake, how long before the next one can count. */
  cooldownMs: 2_000,
} as const;

/**
 * A shake is several hard jolts in quick succession: one bump, a step, or a
 * phone set down is not. Feed it samples in order; it answers true on the one
 * that completes a shake, and then rests for `cooldownMs`.
 */
export function createShakeDetector() {
  let last: MotionSample | null = null;
  let hits: number[] = [];
  let restUntil = Number.NEGATIVE_INFINITY;
  return {
    push(sample: MotionSample): boolean {
      const before = last;
      last = sample;
      if (before === null || sample.t < restUntil) return false;
      const change = Math.hypot(
        sample.x - before.x,
        sample.y - before.y,
        sample.z - before.z,
      );
      if (change < SHAKE.jolt) return false;
      const prior = hits.at(-1);
      if (prior !== undefined && sample.t - prior < SHAKE.gapMs) return false;
      hits = [...hits.filter((t) => sample.t - t <= SHAKE.windowMs), sample.t];
      if (hits.length < SHAKE.hits) return false;
      hits = [];
      restUntil = sample.t + SHAKE.cooldownMs;
      return true;
    },
    reset(): void {
      last = null;
      hits = [];
      restUntil = Number.NEGATIVE_INFINITY;
    },
  };
}
