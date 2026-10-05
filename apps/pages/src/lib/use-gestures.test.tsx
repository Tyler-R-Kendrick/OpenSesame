/** @vitest-environment jsdom */
import { EMPTY_KEYMAP } from "@opensesame/app-core/lib/keymap/config.js";
import { SHAKE } from "@opensesame/app-core/lib/keymap/gesture-recognizer.js";
import {
  resetKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetMotionAccessForTest } from "./gesture-motion.js";
import { registerVaultKeymap } from "./keymap-targets.js";
import { rowIn, vault } from "./keymap.test-harness.js";
import { useGestures } from "./use-gestures.js";

function Shell({ showHelp }: { showHelp: () => void }) {
  useGestures({ navigate: vi.fn(), showHelp });
  return null;
}

type Reading = { x: number; y: number; z: number };

/** One finger as a touch event carries it. */
type Contact = {
  identifier: number;
  clientX: number;
  clientY: number;
  target: EventTarget;
};

class Sensor extends Event {
  accelerationIncludingGravity: Reading;
  acceleration = null;
  constructor(x: number, at: number) {
    super("devicemotion");
    this.accelerationIncludingGravity = { x, y: 0, z: 9.8 };
    Object.defineProperty(this, "timeStamp", { value: at });
  }
}

function shake(from: number) {
  window.dispatchEvent(new Sensor(0, from));
  for (let i = 0; i < SHAKE.hits; i++) {
    window.dispatchEvent(
      new Sensor(i % 2 === 0 ? 40 : -40, from + (i + 1) * 150),
    );
  }
}

function touch(type: string, touches: Contact[], changed: Contact[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changed });
  document.dispatchEvent(event);
}

afterEach(() => {
  cleanup();
  resetKeymap();
  forgetMotionAccessForTest();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the gesture loadout, live in the shell", () => {
  it("listens for two fingers on the document while mounted, and stops after", () => {
    const items = vault();
    const release = registerVaultKeymap(items);
    const target = rowIn("vtree__rows");
    const swipe = () => {
      const a = { identifier: 1, clientX: 100, clientY: 300, target };
      const b = { identifier: 2, clientX: 180, clientY: 300, target };
      touch("touchstart", [a], [a]);
      touch("touchstart", [a, b], [b]);
      const a2 = { ...a, clientY: 200 };
      const b2 = { ...b, clientY: 200 };
      touch("touchmove", [a2, b2], [a2, b2]);
      touch("touchend", [b2], [a2]);
      touch("touchend", [], [b2]);
    };
    const { unmount } = render(<Shell showHelp={vi.fn()} />);
    swipe();
    expect(items.last).toHaveBeenCalledOnce();
    unmount();
    swipe();
    expect(items.last).toHaveBeenCalledOnce();
    release();
  });

  it("listens for a shake only while one is bound and motion is on", () => {
    vi.stubGlobal("DeviceMotionEvent", Sensor);
    const showHelp = vi.fn();
    render(<Shell showHelp={showHelp} />);
    shake(0);
    expect(showHelp).toHaveBeenCalledOnce();

    act(() => {
      saveKeymap({ ...EMPTY_KEYMAP, motion: false });
    });
    shake(10_000);
    expect(showHelp).toHaveBeenCalledOnce();

    act(() => {
      saveKeymap({ ...EMPTY_KEYMAP, gestures: { shake: "nop" } });
    });
    shake(20_000);
    expect(showHelp).toHaveBeenCalledOnce();

    act(() => {
      saveKeymap({ ...EMPTY_KEYMAP });
    });
    shake(30_000);
    expect(showHelp).toHaveBeenCalledTimes(2);
  });

  it("never reads the sensor where the browser has none", () => {
    const showHelp = vi.fn();
    render(<Shell showHelp={showHelp} />);
    expect(() => shake(0)).not.toThrow();
    expect(showHelp).not.toHaveBeenCalled();
  });
});
