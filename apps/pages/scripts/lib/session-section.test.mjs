import { describe, expect, it } from "vitest";
import {
  dismissVaultSwitcher,
  openSessionSection,
} from "./session-section.mjs";

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

/** How long the fake waits for an element before it fails, as a locator does. */
const WAIT_MS = 300;
/** The rail draws the vault's row a moment after the route changes. */
const RENDER_MS = 50;

/**
 * The desktop shell standing on Settings: the tree is rooted there, its `<`
 * key ("Back to vault") is the way back, and the Session menu lists only the
 * session roots (RailRows' SESSION_SECTIONS: Settings and Activity).
 */
function settingsPage() {
  const state = { route: "settings", vaultRowAt: 0, menu: false, asked: [] };
  const visible = {
    "treeitem:Back to vault": () => state.route === "settings",
    "treeitem:Vault": () =>
      state.route === "vault" && Date.now() >= state.vaultRowAt,
    "selector:.rail__prompt .prompt__dim": () => true,
    "menu:Session": () => state.menu,
    "menuitem:Settings": () => state.menu,
    "menuitem:Activity": () => state.menu,
  };
  const actions = {
    "treeitem:Back to vault": () => {
      state.route = "vault";
      state.vaultRowAt = Date.now() + RENDER_MS;
    },
    "selector:.rail__prompt .prompt__dim": () => {
      state.menu = true;
    },
    "menuitem:Settings": () => {
      state.route = "settings";
    },
  };
  const shown = (key) => visible[key]?.() ?? false;
  const settle = async (key) => {
    const end = Date.now() + WAIT_MS;
    while (!shown(key)) {
      if (Date.now() > end) throw new Error(`Timeout waiting for ${key}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const locator = (key) => {
    const self = {
      first: () => self,
      filter: () => self,
      count: async () => (shown(key) ? 1 : 0),
      isVisible: async () => shown(key),
      waitFor: async ({ state: wanted = "visible" } = {}) => {
        if (wanted === "visible") await settle(key);
      },
      click: async () => {
        if (key.startsWith("menuitem:")) state.asked.push(key);
        await settle(key);
        actions[key]?.();
      },
    };
    return self;
  };
  const page = {
    getByRole: (role, { name }) => locator(`${role}:${name}`),
    locator: (selector) => locator(`selector:${selector}`),
    keyboard: { press: async () => {} },
  };
  return { page, state };
}

describe("openSessionSection", () => {
  it("reaches the vault from Settings without asking the Session menu for it", async () => {
    const { page, state } = settingsPage();
    await openSessionSection(page, "Vault");
    expect(state.route).toBe("vault");
    expect(state.asked).toEqual([]);
  });

  it("waits for the vault's row once Back to vault has been pressed", async () => {
    const { page, state } = settingsPage();
    await page.getByRole("treeitem", { name: "Back to vault" }).click();
    await openSessionSection(page, "Vault");
    expect(state.route).toBe("vault");
    expect(state.asked).toEqual([]);
  });

  it("still opens a session root from the Session menu", async () => {
    const { page, state } = settingsPage();
    state.route = "vault";
    await openSessionSection(page, "Settings");
    expect(state.route).toBe("settings");
    expect(state.asked).toEqual(["menuitem:Settings"]);
  });
});
