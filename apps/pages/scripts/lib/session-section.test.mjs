import { describe, expect, it } from "vitest";
import { dismissVaultSwitcher } from "./session-section.mjs";

/**
 * The switcher and nothing else. `hideAt` is how many dismissals (an Escape
 * or a backdrop click) run before the menu is gone. The first `throwClicks`
 * backdrop clicks throw, the way a detached backdrop does.
 */
function switcherPage({ hideAt = 0, throwClicks = 0 } = {}) {
  const actions = [];
  let dismissals = 0;
  let thrown = 0;
  const visible = () => dismissals < hideAt;

  const menu = {
    async isVisible() {
      return visible();
    },
    async waitFor({ state, timeout }) {
      actions.push(["wait", state, timeout]);
      if (state === "hidden" && !visible()) return;
      throw new Error("menu still visible");
    },
  };

  const page = {
    locator(selector) {
      if (selector === ".project-switcher__menu") return menu;
      if (selector === ".project-switcher__backdrop") {
        return {
          async click(options) {
            actions.push(["click", options]);
            if (thrown < throwClicks) {
              thrown += 1;
              throw new Error("element is not stable");
            }
            dismissals += 1;
          },
        };
      }
      throw new Error(`unexpected locator ${selector}`);
    },
    keyboard: {
      async press(key) {
        actions.push(["press", key]);
        if (key === "Escape") dismissals += 1;
      },
    },
  };

  return { page, actions };
}

const gestures = (actions) =>
  actions
    .filter((action) => action[0] === "press" || action[0] === "click")
    .map(([kind, value]) => (kind === "press" ? value : "backdrop"));

describe("dismissVaultSwitcher", () => {
  it("tries Escape before the backdrop", async () => {
    const { page, actions } = switcherPage({ hideAt: 2 });
    await dismissVaultSwitcher(page);
    expect(gestures(actions)).toEqual(["Escape", "backdrop"]);
    const click = actions.find((action) => action[0] === "click");
    expect(click[1]).toEqual({ position: { x: 4, y: 4 }, timeout: 1_000 });
    const waits = actions.filter((action) => action[0] === "wait");
    expect(
      waits.every(
        ([, state, timeout]) =>
          state === "hidden" && timeout > 0 && timeout <= 5_000,
      ),
    ).toBe(true);
  });

  it("retries while the menu stays visible", async () => {
    const { page, actions } = switcherPage({ hideAt: 3 });
    await dismissVaultSwitcher(page);
    expect(gestures(actions)).toEqual(["Escape", "backdrop", "Escape"]);
  });

  it("retries when the backdrop click detaches", async () => {
    const { page, actions } = switcherPage({ hideAt: 2, throwClicks: 1 });
    await dismissVaultSwitcher(page);
    expect(gestures(actions)).toEqual(["Escape", "backdrop", "Escape"]);
  });

  it("still fails when the menu never hides", async () => {
    const { page, actions } = switcherPage({ hideAt: 100 });
    await expect(dismissVaultSwitcher(page)).rejects.toThrow(
      /menu still visible/,
    );
    expect(
      gestures(actions).filter((gesture) => gesture === "Escape").length,
    ).toBeGreaterThan(1);
  });

  it("leaves a closed switcher alone", async () => {
    const { page, actions } = switcherPage({ hideAt: 0 });
    await dismissVaultSwitcher(page);
    expect(gestures(actions)).toEqual([]);
  });
});
