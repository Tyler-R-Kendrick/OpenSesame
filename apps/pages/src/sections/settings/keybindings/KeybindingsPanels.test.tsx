/** @vitest-environment jsdom */
import { ownMacro } from "@opensesame/app-core/lib/keymap/macros.js";
import {
  loadKeymap,
  resetKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { isMountedGuideTarget } from "@opensesame/app-core/tutorial/registry/targets.js";
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

/** Press keys into the focused capture field, then let its timeout lapse. */
function press(...keys: string[]) {
  for (const key of keys) {
    const target = document.activeElement ?? document.body;
    fireEvent.keyDown(target, { key, ctrlKey: false });
  }
}

afterEach(() => {
  cleanup();
  resetKeymap();
  vi.useRealTimers();
});

describe("Settings › Keybindings › Keymap", () => {
  it("draws every command with its keys, grouped, with the fixed keys locked", () => {
    renderPanels();
    expect(screen.getByRole("heading", { name: "Keymap" })).toBeTruthy();
    expect(
      within(row("Next row")).getByRole("button", {
        name: "Change j for Next row",
      }),
    ).toBeTruthy();
    // A command that asks before it acts shows its key and offers no other.
    const trash = row("Move to trash");
    expect(
      within(trash).queryByRole("button", { name: /Add a key/ }),
    ).toBeNull();
    expect(within(trash).getByRole("img", { name: "x" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Fixed" })).toBeTruthy();
  });

  it("records a new key by pressing it, and keeps it after the timeout", () => {
    vi.useFakeTimers();
    renderPanels();
    fireEvent.click(
      within(row("Next row")).getByRole("button", {
        name: "Add a key for Next row",
      }),
    );
    const capture = screen.getByRole("textbox", {
      name: "New key for Next row",
    });
    expect(document.activeElement).toBe(capture);
    press("w");
    act(() => {
      vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    });
    expect(loadKeymap().bindings).toEqual({ w: "listing.next" });
    const added = within(row("Next row")).getByRole("button", {
      name: "Change w for Next row",
    });
    expect(added.className).toContain("keycap-btn--user");
    expect(row("Next row").hasAttribute("data-changed")).toBe(true);
  });

  it("records a sequence, and Escape leaves everything as it was", () => {
    vi.useFakeTimers();
    renderPanels();
    fireEvent.click(
      within(row("Edit")).getByRole("button", { name: "Add a key for Edit" }),
    );
    press(" ", "e");
    act(() => {
      vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    });
    expect(loadKeymap().bindings).toEqual({ "Space e": "item.edit" });

    fireEvent.click(
      within(row("Edit")).getByRole("button", { name: "Add a key for Edit" }),
    );
    press("q", "Escape");
    expect(loadKeymap().bindings).toEqual({ "Space e": "item.edit" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Add a key for Edit",
    );
  });

  it("names what holds a taken key, and swaps it on request", () => {
    vi.useFakeTimers();
    renderPanels();
    fireEvent.click(
      within(row("Next row")).getByRole("button", {
        name: "Change j for Next row",
      }),
    );
    press("k");
    act(() => {
      vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    });
    const prompt = screen.getByRole("group", {
      name: "k is taken by Previous row",
    });
    fireEvent.click(
      within(prompt).getByRole("button", {
        name: "Swap: Previous row takes the key you replaced",
      }),
    );
    expect(loadKeymap().bindings).toEqual({
      j: "listing.previous",
      k: "listing.next",
    });
  });

  it("shows a refused swap in the prompt, and keeps the keymap as it was", () => {
    vi.useFakeTimers();
    renderPanels();
    fireEvent.click(
      within(row("Next row")).getByRole("button", {
        name: "Change j for Next row",
      }),
    );
    press("k");
    act(() => {
      vi.advanceTimersByTime(keymapSeams.goTimeoutMs);
    });
    const prompt = screen.getByRole("group", {
      name: "k is taken by Previous row",
    });
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    fireEvent.click(
      within(prompt).getByRole("button", {
        name: "Swap: Previous row takes the key you replaced",
      }),
    );
    set.mockRestore();
    expect(
      within(
        screen.getByRole("group", { name: "k is taken by Previous row" }),
      ).getByRole("img", {
        name: "The keymap could not be saved on this device.",
      }),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("group", { name: "k is taken by Previous row" }),
      ).getByRole("alert").textContent,
    ).toBe("The keymap could not be saved on this device.");
    expect(loadKeymap().bindings).toEqual({});
  });

  it("refuses a fixed key in place, and keeps recording", () => {
    renderPanels();
    fireEvent.click(
      within(row("Next row")).getByRole("button", {
        name: "Add a key for Next row",
      }),
    );
    press("5", "Enter");
    expect(screen.getByRole("img", { name: /5 is fixed: Count/ })).toBeTruthy();
    expect(loadKeymap().bindings).toEqual({});
  });

  it("finds a command by pressing its keys", () => {
    renderPanels();
    fireEvent.click(
      screen.getByRole("button", { name: "Find by pressing keys" }),
    );
    press("g", "s");
    expect(screen.getByText(/^1 command/)).toBeTruthy();
    expect(row("Settings")).toBeTruthy();
  });

  it("turns single-character keys off with one switch", () => {
    renderPanels();
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Single-character keys run commands",
      }),
    );
    expect(loadKeymap().singleKeys).toBe(false);
  });
});

describe("Settings › Keybindings › tutorial target", () => {
  it("leaves the category link the one owner of settings.keybindings", () => {
    // The Keybindings tab link carries the target; a panel-wrapping one made
    // every click inside the editor read as activating the tab.
    renderPanels();
    expect(isMountedGuideTarget("settings.keybindings")).toBe(false);
    expect(
      document.querySelector('[data-guide-target="settings.keybindings"]'),
    ).toBeNull();
  });
});

describe("Settings › Keybindings › Macros", () => {
  it("lets a macro take a name that is also an object member", () => {
    renderPanels();
    fireEvent.click(screen.getByRole("button", { name: "New macro" }));
    const editor = screen.getByRole("form", { name: "New macro" });
    fireEvent.change(within(editor).getByLabelText("Name"), {
      target: { value: "constructor" },
    });
    // Free on an empty keymap: `constructor` is not "already a macro".
    expect(
      within(editor).queryByRole("img", { name: /already a macro/ }),
    ).toBeNull();
    fireEvent.click(within(editor).getByRole("button", { name: "Add a step" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Save macro" }));
    expect(ownMacro(loadKeymap().macros, "constructor")?.steps).toHaveLength(1);
  });

  it("records steps from keys, runs on an event, and saves whole", () => {
    renderPanels();
    fireEvent.click(screen.getByRole("button", { name: "New macro" }));
    const editor = screen.getByRole("form", { name: "New macro" });
    fireEvent.change(within(editor).getByLabelText("Name"), {
      target: { value: "triage" },
    });
    fireEvent.change(within(editor).getByLabelText("Runs when"), {
      target: { value: "unlock" },
    });
    fireEvent.click(
      within(editor).getByRole("button", {
        name: "Record steps by pressing keys",
      }),
    );
    press("g", "g", "3", "j", "y", "Enter");
    // `y` copies a secret: an event may never run it, so it was left out.
    expect(
      within(editor).getByRole("img", { name: /Left out: item.copy-secret/ }),
    ).toBeTruthy();
    fireEvent.click(within(editor).getByRole("button", { name: "Save macro" }));
    expect(loadKeymap().macros.triage).toEqual({
      on: "unlock",
      steps: [
        { command: "listing.first", count: 1 },
        { command: "listing.next", count: 3 },
      ],
    });
    expect(row("@triage")).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Edit @triage",
    );
  });
});
