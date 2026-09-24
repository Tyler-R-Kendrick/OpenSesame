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

beforeEach(() => {
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
