/** @vitest-environment jsdom */
/** Settings › Keybindings › Keymap by scope, and its Unavailable group (ADR 0150 §6). */
import {
  loadKeymap,
  resetKeymap,
  saveKeymapData,
} from "@opensesame/app-core/lib/keymap/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keymapSeams } from "../../../lib/keymap.js";
import { KeybindingsPanels } from "./KeybindingsPanels.js";

function renderPanels() {
  return render(
    <MemoryRouter initialEntries={["/settings/keybindings"]}>
      <KeybindingsPanels />
    </MemoryRouter>,
  );
}

function row(label: string): HTMLElement {
  const name = screen.getAllByText(label, { selector: ".kb-row__label" })[0];
  const found = name?.closest("li");
  if (!(found instanceof HTMLElement)) throw new Error(`no row ${label}`);
  return found;
}

function chooseScope(label: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "Keys that hold" }), {
    target: { value: label },
  });
}

function press(...keys: string[]) {
  for (const key of keys) {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key,
      ctrlKey: false,
    });
  }
}

function record(label: string, key: string, where = "") {
  fireEvent.click(
    within(row(label)).getByRole("button", {
      name: `Add a key for ${label}${where}`,
    }),
  );
  press(key);
  act(() => {
    vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
  });
}

afterEach(() => {
  cleanup();
  resetKeymap();
  vi.useRealTimers();
});

describe("Keymap scope", () => {
  it("offers everywhere, the vault list and the rail, beside the view filter", () => {
    renderPanels();
    const scope = screen.getByRole("combobox", { name: "Keys that hold" });
    expect(scope.className).toContain("head-filter");
    expect(
      within(scope)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["everywhere", "in the vault list", "in the rail"]);
    expect(screen.getByRole("combobox", { name: "Show" })).toBeTruthy();
  });

  it("records a key into the chosen scope only, marked as scoped", () => {
    vi.useFakeTimers();
    renderPanels();
    chooseScope("vault");
    record("Edit", "w", " in the vault list");
    expect(loadKeymap().bindings).toEqual({});
    expect(loadKeymap().contexts).toEqual({ vault: { w: "item.edit" } });
    const cap = within(row("Edit")).getByRole("button", {
      name: "Change w for Edit in the vault list",
    });
    expect(cap.className).toContain("keycap-btn--scoped");
    expect(cap.getAttribute("title")).toContain("in the vault list");
    chooseScope("everywhere");
    expect(
      within(row("Edit")).queryByRole("button", { name: /Change w for/ }),
    ).toBeNull();
    chooseScope("rail");
    expect(
      within(row("Edit")).queryByRole("button", { name: /Change w for/ }),
    ).toBeNull();
  });

  it("shows global keys in a scope, and a key struck there as struck", () => {
    renderPanels();
    chooseScope("rail");
    expect(
      within(row("Next row")).getByRole("button", {
        name: "Change j for Next row",
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(row("Next row")).getByRole("button", {
        name: "Change j for Next row",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Remove j from Next row/ }),
    );
    expect(loadKeymap().contexts).toEqual({ rail: { j: "nop" } });
    expect(loadKeymap().bindings).toEqual({});
    const struck = within(row("Next row")).getByRole("button", {
      name: "Restore j for Next row in the rail",
    });
    expect(struck.className).toContain("keycap-btn--removed");
    fireEvent.click(struck);
    expect(loadKeymap().contexts).toBeUndefined();
  });

  it("finds a conflict against the scope's own keymap, and swaps within it", () => {
    vi.useFakeTimers();
    saveKeymapData({
      bindings: {},
      macros: {},
      contexts: { vault: { w: "item.edit" } },
    });
    renderPanels();
    chooseScope("vault");
    fireEvent.click(
      within(row("Next row")).getByRole("button", {
        name: "Add a key for Next row in the vault list",
      }),
    );
    press("w");
    act(() => {
      vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    });
    const prompt = screen.getByRole("group", { name: "w is taken by Edit" });
    fireEvent.click(
      within(prompt).getByRole("button", { name: /Replace|Take/ }),
    );
    expect(loadKeymap().contexts?.vault).toEqual({ w: "listing.next" });
    expect(loadKeymap().bindings).toEqual({});
  });

  it("does not see a vault-only key as a conflict in the rail", () => {
    vi.useFakeTimers();
    saveKeymapData({
      bindings: {},
      macros: {},
      contexts: { vault: { w: "item.edit" } },
    });
    renderPanels();
    chooseScope("rail");
    record("Next row", "w", " in the rail");
    expect(screen.queryByRole("group", { name: /is taken by/ })).toBeNull();
    expect(loadKeymap().contexts).toEqual({
      vault: { w: "item.edit" },
      rail: { w: "listing.next" },
    });
  });

  it("resets one command in the scope it is shown in", () => {
    saveKeymapData({
      bindings: { W: "item.edit" },
      macros: {},
      contexts: { vault: { w: "item.edit" } },
    });
    renderPanels();
    chooseScope("vault");
    fireEvent.click(
      within(row("Edit")).getByRole("button", {
        name: "Reset Edit to its default keys",
      }),
    );
    expect(loadKeymap().contexts).toBeUndefined();
    expect(loadKeymap().bindings).toEqual({ W: "item.edit" });
  });

  it("filters to what changed in the chosen scope", () => {
    saveKeymapData({
      bindings: {},
      macros: {},
      contexts: { vault: { w: "item.edit" } },
    });
    renderPanels();
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), {
      target: { value: "changed" },
    });
    expect(
      screen.queryByText("Edit", { selector: ".kb-row__label" }),
    ).toBeNull();
    chooseScope("vault");
    expect(row("Edit").hasAttribute("data-changed")).toBe(true);
  });
});

describe("Unavailable bindings", () => {
  it("lists a key for a command this plan lacks, before Fixed", () => {
    saveKeymapData({
      bindings: { "g c": "section.connections" },
      macros: {},
      contexts: { vault: { z: "section.connections" } },
    });
    renderPanels();
    const heading = screen.getByRole("heading", { name: "Unavailable" });
    const group = heading.closest("section");
    if (!group) throw new Error("no group");
    expect(within(group).getAllByText("section.connections")).toHaveLength(2);
    expect(
      within(group).getAllByRole("img", {
        name: "section.connections is not available on this plan",
      }),
    ).toHaveLength(2);
    expect(
      within(group).getByRole("img", { name: /^z .*in the vault list$/ }),
    ).toBeTruthy();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((item) => item.textContent);
    expect(headings.indexOf("Unavailable")).toBe(headings.length - 2);
    expect(headings.at(-1)).toBe("Fixed");
  });

  it("removes one with its icon key, and the group goes with the last", () => {
    saveKeymapData({
      bindings: { "g c": "section.connections" },
      macros: {},
      contexts: { vault: { z: "section.connections" } },
    });
    renderPanels();
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Remove z .*in the vault list from section.connections/,
      }),
    );
    expect(loadKeymap().contexts).toBeUndefined();
    expect(loadKeymap().bindings).toEqual({ "g c": "section.connections" });
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Remove g .*c from section.connections/,
      }),
    );
    expect(loadKeymap().bindings).toEqual({});
    expect(screen.queryByRole("heading", { name: "Unavailable" })).toBeNull();
  });

  it("is absent when nothing is unavailable", () => {
    renderPanels();
    expect(screen.queryByRole("heading", { name: "Unavailable" })).toBeNull();
  });
});
