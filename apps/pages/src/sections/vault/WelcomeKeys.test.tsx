/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WelcomeKeys, welcomeKeys, welcomeTouch } from "./WelcomeKeys.js";

afterEach(cleanup);

const KEY_WORDS = /\b(enter|esc|keys?|press)\b|\bn new\b|\/ search|\?/i;

describe("WelcomeKeys", () => {
  it("keeps the desktop line exactly as it was", () => {
    expect(welcomeKeys(false, true)).toBe("n new · import · ? keys");
    expect(welcomeKeys(false, false)).toBe(
      "enter open · n new · / search · ? keys",
    );
    expect(welcomeKeys(true, true)).toBe("r restore · X delete · ? keys");
    expect(welcomeKeys(true, false)).toBe(
      "enter open · r restore · X delete · / search · ? keys",
    );
  });

  it("draws both voices where a finger has its own", () => {
    for (const [inTrash, empty] of [
      [false, true],
      [false, false],
      [true, false],
    ] as const) {
      const { container } = render(
        <WelcomeKeys inTrash={inTrash} empty={empty} />,
      );
      const line = container.querySelector(".buffer__keys");
      expect(line?.querySelector(".buffer__keys-keys")?.textContent).toBe(
        welcomeKeys(inTrash, empty),
      );
      const touch = line?.querySelector(".buffer__keys-touch")?.textContent;
      expect(touch).toBe(welcomeTouch(inTrash, empty));
      expect(touch).not.toMatch(KEY_WORDS);
      cleanup();
    }
  });

  it("names the touch road for each state", () => {
    expect(welcomeTouch(false, true)).toBe("tap + to add an item, or import");
    expect(welcomeTouch(false, false)).toBe("hold or swipe a row for actions");
    expect(welcomeTouch(true, false)).toBe(
      "hold or swipe a row to restore or delete",
    );
  });

  it("goes quiet on a phone where there is nothing to do", () => {
    // An empty trash has nothing a finger could act on: the keys-only line is
    // the one `(pointer: coarse)` hides, and no touch twin is drawn.
    const { container } = render(<WelcomeKeys inTrash empty />);
    const line = container.querySelector(".buffer__keys");
    expect(line?.className).toContain("buffer__keys--keys");
    expect(line?.textContent).toBe("r restore · X delete · ? keys");
    expect(container.querySelector(".buffer__keys-touch")).toBeNull();
  });
});
