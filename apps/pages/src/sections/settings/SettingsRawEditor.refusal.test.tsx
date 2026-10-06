/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInTray, inTray } from "../../components/tray.test-support.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { SettingsRawEditor } from "./SettingsRawEditor.js";

// The device's own refusal: the store will not take the write.
const REFUSAL = "The keymap could not be saved on this device.";

const vault = {
  prefs: {
    theme: "system" as const,
    autoLockMinutes: 0,
    clipboardClearSeconds: 30,
    lockOnHide: false,
    signOutOnLock: false,
  },
  header: null,
};
const store = { commitPrefs: vi.fn(async () => undefined) };
const original = { ...vaultHooksSeams };

function refuseWrites() {
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
}

let writes: ReturnType<typeof refuseWrites> | undefined;

beforeEach(() => {
  writes = refuseWrites();
  Object.assign(vaultHooksSeams, {
    useVault: () => vault,
    useVaultStore: () => store,
  });
});

afterEach(() => {
  cleanup();
  writes?.mockRestore();
  Object.assign(vaultHooksSeams, original);
});

const PATH = "settings/keybindings/config.yaml";

function keymapFile(): HTMLTextAreaElement {
  const field = screen.getByLabelText(PATH);
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("no file");
  return field;
}

function typeAndSave(): void {
  fireEvent.change(keymapFile(), {
    target: { value: `# mine\n${keymapFile().value}` },
  });
  fireEvent.keyDown(keymapFile(), { key: "s", ctrlKey: true });
}

describe("a refused commit in the settings file", () => {
  it("lands in the tray and as a mark on the file, never as page text", async () => {
    render(<SettingsRawEditor category="keybindings" />);
    typeAndSave();
    await expectInTray(REFUSAL);
    expect(screen.getByRole("img", { name: REFUSAL })).toBeTruthy();
  });

  it("clears once the file is edited", async () => {
    render(<SettingsRawEditor category="keybindings" />);
    typeAndSave();
    await expectInTray(REFUSAL);
    fireEvent.change(keymapFile(), {
      target: { value: `# again\n${keymapFile().value}` },
    });
    await vi.waitFor(() => expect(inTray(REFUSAL)).toBe(false));
    expect(screen.queryByRole("img", { name: REFUSAL })).toBeNull();
  });

  it("clears once a later save succeeds", async () => {
    render(<SettingsRawEditor category="keybindings" />);
    typeAndSave();
    await expectInTray(REFUSAL);
    writes?.mockRestore();
    fireEvent.keyDown(keymapFile(), { key: "s", ctrlKey: true });
    await vi.waitFor(() => expect(inTray(REFUSAL)).toBe(false));
    expect(screen.queryByRole("img", { name: REFUSAL })).toBeNull();
  });

  it("does not follow the editor to another settings file", async () => {
    const view = render(<SettingsRawEditor category="keybindings" />);
    typeAndSave();
    await expectInTray(REFUSAL);
    view.rerender(<SettingsRawEditor category="general" />);
    expect(screen.queryByRole("img", { name: REFUSAL })).toBeNull();
    // A notice outlives its screen, but only under the file it was raised
    // for: the other file raises nothing.
    const ids = listNotices()
      .filter((notice) => notice.body === REFUSAL)
      .map((notice) => notice.id);
    expect(ids).toEqual([`settings-file:${PATH}`]);
  });
});
