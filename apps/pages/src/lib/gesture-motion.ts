/**
 * The phone's motion sensor, for the one gesture that is made by moving it
 * (ADR 0165): a shake. Three things are true of it that are not true of a
 * touch, and each is handled here rather than assumed:
 *
 * - Some browsers (iOS Safari) give a page the sensor only after a person
 *   allows it, and only from a tap. Nothing here asks on its own: the Gestures
 *   panel draws an Allow key where one is needed, and that key calls
 *   `requestMotionAccess`.
 * - A shake can be an accident (a pocket, a bus), so it can be switched off
 *   (`motion: false`, WCAG 2.5.4), and it is not listened for at all while it
 *   is off or bound to nothing.
 * - Nothing is gesture-only: whatever a shake runs is also a key or a control.
 */
import {
  type MotionSample,
  createShakeDetector,
} from "@opensesame/app-core/lib/keymap/gesture-recognizer.js";
import { isFunction, isNumber, overlapCast } from "@opensesame/os-domain";

/**
 * `ready`: the browser needs no permission. `needs-permission`: it does, and
 * has not been given. `granted` / `denied`: the person answered.
 * `unsupported`: no motion sensor API at all.
 */
export type MotionAccess =
  | "unsupported"
  | "ready"
  | "needs-permission"
  | "granted"
  | "denied";

/** The sensor's constructor, which on iOS Safari carries a permission prompt. */
type PromptingSensor = Readonly<{
  requestPermission?: () => Promise<string>;
}>;

/** Whether this browser has a motion sensor API at all. */
function hasSensor(): boolean {
  return "DeviceMotionEvent" in globalThis;
}

/** The browser's permission prompt, where it has one. */
function permissionPrompt(): (() => Promise<string>) | null {
  if (!hasSensor()) return null;
  // SAFETY: lib.dom does not declare iOS's `requestPermission`; the member is
  // optional here and checked as a function before it is called.
  const sensor = overlapCast<typeof DeviceMotionEvent, PromptingSensor>(
    DeviceMotionEvent,
  );
  const ask = sensor.requestPermission;
  return isFunction(ask) ? () => ask.call(DeviceMotionEvent) : null;
}

function initialAccess(): MotionAccess {
  if (!hasSensor()) return "unsupported";
  return permissionPrompt() === null ? "ready" : "needs-permission";
}

let access: MotionAccess | null = null;
const listeners = new Set<() => void>();

function setAccess(next: MotionAccess): void {
  if (access === next) return;
  access = next;
  for (const listener of listeners) listener();
}

export function motionAccessSnapshot(): MotionAccess {
  access ??= initialAccess();
  return access;
}

export function subscribeMotionAccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ask the person to allow the motion sensor. Only a tap may call this: the
 * browser refuses it from anywhere else. Where no prompt exists it changes
 * nothing.
 */
export async function requestMotionAccess(): Promise<MotionAccess> {
  const ask = permissionPrompt();
  if (ask === null) return motionAccessSnapshot();
  try {
    setAccess((await ask()) === "granted" ? "granted" : "denied");
  } catch {
    setAccess("denied");
  }
  return motionAccessSnapshot();
}

/** Forget the answer, as a fresh page load would (tests). */
export function forgetMotionAccessForTest(): void {
  access = null;
}

/** One reading of the accelerometer, or null when it holds no usable numbers. */
function sampleOf(event: DeviceMotionEvent): MotionSample | null {
  const reading = event.accelerationIncludingGravity ?? event.acceleration;
  if (!reading) return null;
  const { x, y, z } = reading;
  if (!isNumber(x) || !isNumber(y) || !isNumber(z)) return null;
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z, t: event.timeStamp };
}

/**
 * Listen for a shake. A browser that has the sensor behind a prompt sends
 * nothing until it is allowed, so listening before then is free, and the first
 * reading that arrives is proof it was. Returns the way to stop.
 */
export function listenForShake(
  onShake: () => void,
  target: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  > = window,
): () => void {
  if (motionAccessSnapshot() === "unsupported") return () => undefined;
  const detector = createShakeDetector();
  const listener = (event: Event) => {
    if (!(event instanceof DeviceMotionEvent)) return;
    const sample = sampleOf(event);
    if (sample === null) return;
    if (motionAccessSnapshot() === "needs-permission") setAccess("granted");
    if (detector.push(sample)) onShake();
  };
  target.addEventListener("devicemotion", listener);
  return () => {
    target.removeEventListener("devicemotion", listener);
    detector.reset();
  };
}
