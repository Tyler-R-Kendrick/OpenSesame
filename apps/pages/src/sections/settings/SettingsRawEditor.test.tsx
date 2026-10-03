/** @vitest-environment jsdom */
import type { VaultPrefs } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { SettingsSection } from "../SettingsSection.js";
import { SettingsRawEditor } from "./SettingsRawEditor.js";

const prefs = (theme: VaultPrefs["theme"]): VaultPrefs => ({
  theme,
  autoLockMinutes: 0,
  clipboardClearSeconds: 30,
  lockOnHide: false,
  signOutOnLock: false,
});

const vault = { prefs: prefs("system"), header: null };
const store = { commitPrefs: vi.fn(async () => undefined) };
const original = { ...vaultHooksSeams };

function ensureMemoryLocalStorage(): void {
  const existing = globalThis.localStorage;
  if (existing?.getItem !== undefined) return;
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: true,
    value: {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        const value = store.get(key);
        return value === undefined ? null : value;
      },
      key(index: number) {
        return [...store.keys()][index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
    },
  });
}

beforeEach(() => {
  ensureMemoryLocalStorage();
  localStorage.clear();
  vault.prefs = prefs("system");
  store.commitPrefs.mockClear();
  Object.assign(vaultHooksSeams, {
    useVault: () => vault,
    useVaultStore: () => store,
  });
});

afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
});

function file(): HTMLTextAreaElement {
  const field = screen.getByLabelText("settings/general/config.yaml");
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("no file");
  return field;
}

describe("a settings directory's config.yaml", () => {
  it("replaces the form on its own route, with no representation toggle", () => {
    render(
      <MemoryRouter initialEntries={["/settings?file=config.yaml"]}>
        <SettingsSection
          panels={{
            InstallPanel: () => null,
            UnlockMethodsPanel: () => null,
          }}
        />
      </MemoryRouter>,
    );
    expect(file().value).toContain('theme: "system"');
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
  });

  it("writes the page when the file is saved", async () => {
    render(<SettingsRawEditor category="general" />);
    fireEvent.change(file(), {
      target: { value: file().value.replace('"system"', "dark # night") },
    });
    fireEvent.keyDown(file(), { key: "s", ctrlKey: true });
    await vi.waitFor(() =>
      expect(store.commitPrefs).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "dark" }),
      ),
    );
  });

  it("follows the page when the form changes, keeping the person's comments", async () => {
    const view = render(<SettingsRawEditor category="general" />);
    fireEvent.change(file(), {
      target: { value: `# laptop\n${file().value}` },
    });
    fireEvent.keyDown(file(), { key: "s", ctrlKey: true });
    await vi.waitFor(() => expect(store.commitPrefs).toHaveBeenCalled());

    // The Appearance form picks Night: the file says so, comment intact.
    vault.prefs = prefs("dark");
    view.rerender(<SettingsRawEditor category="general" />);
    expect(file().value).toContain("# laptop");
    expect(file().value).toMatch(/theme: "?dark"?/);
  });

  describe("Tab", () => {
    function keymapFile(): HTMLTextAreaElement {
      const field = screen.getByLabelText("settings/keybindings/config.yaml");
      if (!(field instanceof HTMLTextAreaElement)) throw new Error("no file");
      return field;
    }

    function type(field: HTMLTextAreaElement, text: string) {
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: text } });
      field.setSelectionRange(text.length, text.length);
    }

    /** True when the press was left to the browser (focus moves on). */
    const tab = (field: HTMLElement) =>
      fireEvent.keyDown(field, { key: "Tab" });
    const shiftTab = (field: HTMLElement) =>
      fireEvent.keyDown(field, { key: "Tab", shiftKey: true });

    it("completes a half-typed key at the end of its line", () => {
      render(<SettingsRawEditor category="general" />);
      type(file(), "th");
      expect(tab(file())).toBe(false);
      expect(file().value).toBe("theme: ");
    });

    it("leaves a macro's steps line alone and lets focus move", () => {
      render(<SettingsRawEditor category="keybindings" />);
      const steps = "macros:\n  triage:\n    steps: [3 listing.next]";
      type(keymapFile(), steps);
      expect(tab(keymapFile())).toBe(true);
      expect(keymapFile().value).toBe(steps);
      type(keymapFile(), `${steps}\n    s`);
      expect(tab(keymapFile())).toBe(true);
      expect(keymapFile().value).toBe(`${steps}\n    s`);
    });

    it("lets focus move from an empty line, a finished word, Shift-Tab and a fresh focus", () => {
      render(<SettingsRawEditor category="keybindings" />);
      type(keymapFile(), "keybindings:\n  ");
      expect(tab(keymapFile())).toBe(true);
      type(keymapFile(), "keybindings:\n  w: nop");
      expect(tab(keymapFile())).toBe(true);
      type(keymapFile(), "keybindings:\n  w: item.s");
      expect(shiftTab(keymapFile())).toBe(true);
      expect(keymapFile().value).toBe("keybindings:\n  w: item.s");
      // Landed on by Tab, nothing typed yet: it is not the person's word.
      fireEvent.focus(keymapFile());
      expect(tab(keymapFile())).toBe(true);
      expect(keymapFile().value).toBe("keybindings:\n  w: item.s");
    });

    it("completes an action id inside keybindings", () => {
      render(<SettingsRawEditor category="keybindings" />);
      type(keymapFile(), "keybindings:\n  s: item.s");
      expect(tab(keymapFile())).toBe(false);
      expect(keymapFile().value).toBe("keybindings:\n  s: item.share");
    });

    it("does not complete an action the file would refuse for that key", () => {
      render(<SettingsRawEditor category="keybindings" />);
      type(keymapFile(), "keybindings:\n  w: item.s");
      expect(screen.queryByRole("button", { name: "item.share" })).toBeNull();
      expect(tab(keymapFile())).toBe(true);
      expect(keymapFile().value).toBe("keybindings:\n  w: item.s");
    });

    it("lists what matches what is typed, quoting a key YAML would misread", () => {
      render(<SettingsRawEditor category="keybindings" />);
      type(keymapFile(), "keybindings:\n  s: item.s");
      expect(screen.getByRole("button", { name: "item.share" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "item.new" })).toBeNull();
      type(keymapFile(), "keybindings:\n  Control+l");
      expect(screen.getByRole("button", { name: '"Control+l"' })).toBeTruthy();
    });
  });

  it("offers no completion for a value that is already typed", () => {
    render(<SettingsRawEditor category="general" />);
    const text = "lockOnHide: false";
    fireEvent.change(file(), {
      target: { value: text, selectionStart: text.length },
    });
    fireEvent.keyUp(file(), { key: "e" });
    expect(screen.queryByRole("list", { name: "Completions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "false" })).toBeNull();

    // Half a value still completes; the same list returns.
    const partial = "lockOnHide: fa";
    fireEvent.change(file(), {
      target: { value: partial, selectionStart: partial.length },
    });
    expect(screen.getByRole("list", { name: "Completions" }).textContent).toBe(
      "false",
    );
  });

  it("completes a finished key with its colon on Tab", () => {
    render(<SettingsRawEditor category="general" />);
    const text = "theme";
    fireEvent.change(file(), {
      target: { value: text, selectionStart: text.length },
    });
    expect(screen.getByRole("list", { name: "Completions" }).textContent).toBe(
      "theme",
    );
    fireEvent.keyDown(file(), { key: "Tab" });
    expect(file().value).toBe("theme: ");
  });

  it("refuses a file that rewrites what a ceremony owns", () => {
    render(<SettingsRawEditor category="security" />);
    const field = screen.getByLabelText("settings/security/config.yaml");
    fireEvent.change(field, { target: { value: "unlockMethods: [pin]\n" } });
    expect(
      screen.getByRole("img", {
        name: "unlockMethods is read-only here; change it on its page.",
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Write settings/security/config.yaml" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
