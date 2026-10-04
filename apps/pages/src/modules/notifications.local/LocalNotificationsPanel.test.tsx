/** @vitest-environment jsdom */
import { readPreference } from "@opensesame/app-core/lib/local-notifications/preference.js";
import { lockAllTombs, unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { declareTutorialForTest } from "../tutorial-test-realm.js";
import { LocalNotificationsPanel } from "./LocalNotificationsPanel.js";
import { TUTORIAL } from "./runtime.js";

const vault = { tomb: "" };
const realUseVault = vaultHooksSeams.useVault;
let undeclare: () => void;
beforeAll(async () => {
  // The panel names its guide target, declared the way the loader would.
  // The test realm approves a capability its fixture catalog holds; the panel's
  // own target is declared under one it does, which is all a mount needs.
  undeclare = await declareTutorialForTest("access.authority", TUTORIAL);
});
afterAll(() => undeclare());

const requestPermission = vi.fn();

function permission(value: NotificationPermission | undefined) {
  if (value === undefined) {
    vi.stubGlobal("Notification", undefined);
    return;
  }
  vi.stubGlobal("Notification", {
    permission: value,
    requestPermission: requestPermission.mockImplementation(async () => {
      Object.assign(Notification, { permission: "granted" });
      return "granted";
    }),
  });
}

beforeEach(async () => {
  vaultHooksSeams.useVault = () => ({ ...realUseVault(), tomb: vault.tomb });
  vault.tomb = `panel-${crypto.randomUUID()}`;
  unlockTomb(vault.tomb, (await mintVaultKey()).vaultKey);
  requestPermission.mockReset();
});
afterEach(() => {
  vaultHooksSeams.useVault = realUseVault;
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
});

const key = (name: string) => screen.findByRole("button", { name });

describe("the system notification row", () => {
  it("asks the browser for permission on its key and not before", async () => {
    permission("default");
    render(<LocalNotificationsPanel />);
    const allow = await key("Allow system notifications");
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(allow);
    await waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
    expect(await key("Turn off system notifications")).toBeTruthy();
  });

  it("turns off and on again once it is permitted, and the preference follows", async () => {
    permission("granted");
    render(<LocalNotificationsPanel />);
    fireEvent.click(await key("Turn off system notifications"));
    await waitFor(async () =>
      expect((await readPreference(vault.tomb)).destinations).toEqual([
        "in_app",
        "tab_title",
      ]),
    );
    fireEvent.click(await key("Turn on system notifications"));
    await waitFor(async () =>
      expect((await readPreference(vault.tomb)).destinations).toContain(
        "system",
      ),
    );
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("is not drawn where the browser refused it or cannot show one: nothing here could change that", async () => {
    for (const value of ["denied", undefined] as const) {
      permission(value);
      const { unmount } = render(<LocalNotificationsPanel />);
      await key("Turn off tab title and badge");
      expect(screen.queryByText("System notifications")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /system notifications/i }),
      ).toBeNull();
      unmount();
    }
  });
});

describe("the tab title row", () => {
  it("toggles the place, keeping the rest of the order", async () => {
    permission("granted");
    render(<LocalNotificationsPanel />);
    fireEvent.click(await key("Turn off tab title and badge"));
    await waitFor(async () =>
      expect((await readPreference(vault.tomb)).destinations).toEqual([
        "in_app",
        "system",
      ]),
    );
    fireEvent.click(await key("Turn on tab title and badge"));
    await waitFor(async () =>
      expect((await readPreference(vault.tomb)).destinations).toEqual([
        "in_app",
        "system",
        "tab_title",
      ]),
    );
  });
});

describe("what the panel is", () => {
  it("has no row for the bell: the inbox is always on, so there is nothing to press", async () => {
    permission("granted");
    render(<LocalNotificationsPanel />);
    await key("Turn off tab title and badge");
    expect(screen.queryByText(/bell|in.app|inbox/i)).toBeNull();
    // The preference never loses it however the keys are pressed.
    fireEvent.click(await key("Turn off system notifications"));
    fireEvent.click(await key("Turn off tab title and badge"));
    await waitFor(async () =>
      expect((await readPreference(vault.tomb)).destinations).toContain(
        "in_app",
      ),
    );
  });

  it("names no service, no push and no relay, and has no disabled key", async () => {
    permission("default");
    const { container } = render(<LocalNotificationsPanel />);
    await key("Allow system notifications");
    expect(container.textContent).not.toMatch(
      /push|server|service|relay|identity|connect/i,
    );
    for (const button of screen.getAllByRole("button"))
      expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("draws every key with its sentence as its name and its title", async () => {
    permission("default");
    render(<LocalNotificationsPanel />);
    await key("Allow system notifications");
    for (const button of screen.getAllByRole("button"))
      expect(button.getAttribute("title")).toBe(
        button.getAttribute("aria-label"),
      );
  });
});
