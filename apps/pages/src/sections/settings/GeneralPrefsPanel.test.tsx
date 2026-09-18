/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralPrefsPanel } from "./GeneralPrefsPanel.js";

const setPrefs = vi.fn();
const commitPrefs = vi.fn(async (next: unknown) => {
  setPrefs(next);
});
const writePrefsSource = vi.fn(async () => undefined);
const readPrefsSource = vi.fn(async () => null);

vi.mock("../../lib/vault/hooks.js", () => ({
  useVaultStore: () => ({
    setPrefs,
    commitPrefs,
    writePrefsSource,
    readPrefsSource,
    activeTomb: () => "personal",
  }),
  useVault: () => ({
    prefs: {
      theme: "system",
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      prefsRevision: 2,
    },
  }),
}));

vi.mock("../../lib/theme.js", () => ({
  setTheme: vi.fn(),
  useThemePreference: () => "system",
}));

vi.mock("../../tutorial/registry/react.jsx", () => ({
  useGuideTarget: () => ({ current: null }),
}));

describe("GeneralPrefsPanel", () => {
  afterEach(() => {
    cleanup();
    setPrefs.mockClear();
    commitPrefs.mockClear();
  });

  it("keeps a source custom idle timeout in Visual and commits through save", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GeneralPrefsPanel />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "Source" }));
    const source = screen.getByLabelText("Source") as HTMLTextAreaElement;
    fireEvent.change(source, {
      target: {
        value: `# keep
theme: dark
autoLockMinutes: 7
lockOnHide: false
signOutOnLock: false
clipboardClearSeconds: 30
`,
      },
    });
    expect(source.value).toContain("autoLockMinutes: 7");
    expect(source.value).toContain("# keep");
    await user.click(screen.getByRole("button", { name: "Visual" }));
    const select = screen.getByLabelText(/Lock after inactivity/i);
    expect((select as HTMLSelectElement).value).toBe("7");
    expect(setPrefs).not.toHaveBeenCalled();
    expect(commitPrefs).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(commitPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ autoLockMinutes: 7, theme: "dark" }),
    );
    expect(screen.getByText(/Preferences saved|Saved source/i)).toBeTruthy();
  });
});
