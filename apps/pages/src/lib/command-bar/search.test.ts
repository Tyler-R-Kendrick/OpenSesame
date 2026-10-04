import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitToConsumer,
  liveSearch,
  publishSearch,
  registerSearchConsumer,
} from "./search.js";

const stops: (() => void)[] = [];
const register = (...args: Parameters<typeof registerSearchConsumer>) => {
  const stop = registerSearchConsumer(...args);
  stops.push(stop);
  return stop;
};

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  publishSearch(null);
});

describe("the prompt's published search", () => {
  it("holds the words until it is told otherwise", () => {
    expect(liveSearch()).toBeNull();
    publishSearch("bank");
    expect(liveSearch()).toBe("bank");
    publishSearch(null);
    expect(liveSearch()).toBeNull();
  });
});

describe("handing the keyboard to a listing", () => {
  it("is `none` when nothing on screen is searching", () => {
    register({ visible: () => false, focus: () => true });
    expect(commitToConsumer()).toBe("none");
  });

  it("is `took` only when focus really landed", () => {
    const focus = vi.fn(() => true);
    register({ visible: () => true, focus });
    expect(commitToConsumer()).toBe("took");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("is `seen` when a listing is there but has nothing to take focus", () => {
    register({ visible: () => true, focus: () => false });
    expect(commitToConsumer()).toBe("seen");
    stops.pop()?.();
    register({ visible: () => true });
    expect(commitToConsumer()).toBe("seen");
  });

  it("skips a hidden pane and lets a visible one answer", () => {
    const hidden = vi.fn(() => true);
    register({ visible: () => false, focus: hidden });
    register({ visible: () => true, focus: () => true });
    expect(commitToConsumer()).toBe("took");
    expect(hidden).not.toHaveBeenCalled();
  });
});
