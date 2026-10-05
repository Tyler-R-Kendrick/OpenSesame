/** @vitest-environment jsdom */
import { SHAKE } from "@opensesame/app-core/lib/keymap/gesture-recognizer.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetMotionAccessForTest,
  listenForShake,
  motionAccessSnapshot,
  requestMotionAccess,
  subscribeMotionAccess,
} from "./gesture-motion.js";

type Reading = { x: number; y: number; z: number } | null;

/** A DeviceMotionEvent jsdom does not have, with the fields the listener reads. */
class FakeMotion extends Event {
  accelerationIncludingGravity: Reading;
  acceleration: Reading = null;
  constructor(reading: Reading, at: number) {
    super("devicemotion");
    this.accelerationIncludingGravity = reading;
    Object.defineProperty(this, "timeStamp", { value: at });
  }
}

function stubSensor(prompt?: () => Promise<string>) {
  class Sensor extends FakeMotion {}
  if (prompt) Object.assign(Sensor, { requestPermission: prompt });
  vi.stubGlobal("DeviceMotionEvent", Sensor);
  return Sensor;
}

function swing(
  target: EventTarget,
  Sensor: typeof FakeMotion,
  from: number,
  jolts: number,
) {
  target.dispatchEvent(new Sensor({ x: 0, y: 0, z: 9.8 }, from));
  for (let i = 0; i < jolts; i++) {
    const x = i % 2 === 0 ? 40 : -40;
    target.dispatchEvent(new Sensor({ x, y: 0, z: 9.8 }, from + (i + 1) * 150));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  forgetMotionAccessForTest();
});

describe("who may read the motion sensor", () => {
  it("reads as unsupported where the browser has none", () => {
    expect(motionAccessSnapshot()).toBe("unsupported");
    const stop = listenForShake(vi.fn());
    stop();
  });

  it("needs no permission where the browser gives none", () => {
    stubSensor();
    expect(motionAccessSnapshot()).toBe("ready");
  });

  it("asks only when told to, and remembers the answer", async () => {
    const prompt = vi.fn(async () => "granted");
    stubSensor(prompt);
    expect(motionAccessSnapshot()).toBe("needs-permission");
    expect(prompt).not.toHaveBeenCalled();
    const heard = vi.fn();
    const off = subscribeMotionAccess(heard);
    expect(await requestMotionAccess()).toBe("granted");
    expect(heard).toHaveBeenCalledOnce();
    off();
  });

  it("reads a refusal, or a prompt that throws, as denied", async () => {
    stubSensor(async () => "denied");
    expect(await requestMotionAccess()).toBe("denied");
    forgetMotionAccessForTest();
    stubSensor(async () => {
      throw new Error("not from a tap");
    });
    expect(await requestMotionAccess()).toBe("denied");
  });

  it("changes nothing where there is no prompt", async () => {
    stubSensor();
    expect(await requestMotionAccess()).toBe("ready");
  });
});

describe("listening for a shake", () => {
  it("calls back once for a shake and not for a nudge", () => {
    const Sensor = stubSensor();
    const target = new EventTarget();
    const onShake = vi.fn();
    const stop = listenForShake(onShake, target);
    swing(target, Sensor, 0, 1);
    expect(onShake).not.toHaveBeenCalled();
    swing(target, Sensor, 5_000, SHAKE.hits);
    expect(onShake).toHaveBeenCalledOnce();
    stop();
  });

  it("ignores readings with nothing in them and other events", () => {
    const Sensor = stubSensor();
    const target = new EventTarget();
    const onShake = vi.fn();
    listenForShake(onShake, target);
    target.dispatchEvent(new Sensor(null, 0));
    target.dispatchEvent(new Event("devicemotion"));
    target.dispatchEvent(new Sensor({ x: 1, y: 2, z: Number.NaN }, 10));
    expect(onShake).not.toHaveBeenCalled();
  });

  it("takes the first reading as proof the sensor was allowed", () => {
    const Sensor = stubSensor(async () => "granted");
    const target = new EventTarget();
    listenForShake(vi.fn(), target);
    expect(motionAccessSnapshot()).toBe("needs-permission");
    target.dispatchEvent(new Sensor({ x: 0, y: 0, z: 9.8 }, 0));
    expect(motionAccessSnapshot()).toBe("granted");
  });

  it("stops listening when asked", () => {
    const Sensor = stubSensor();
    const target = new EventTarget();
    const onShake = vi.fn();
    listenForShake(onShake, target)();
    swing(target, Sensor, 0, SHAKE.hits);
    expect(onShake).not.toHaveBeenCalled();
  });
});
