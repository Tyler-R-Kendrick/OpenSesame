import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PERSONAL_PROJECT_ID,
  projectSeams,
} from "@opensesame/app-core/lib/projects.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { vaultsSeams } from "@opensesame/app-core/lib/vaults.js";
import { expectInTray } from "../../components/tray.test-support.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { VaultsPanel } from "./VaultsPanel.js";

const state = {
  v: 1 as const,
  projects: [
    {
      id: PERSONAL_PROJECT_ID,
      name: "Personal",
      kind: "personal" as const,
      createdAt: "2025-01-01T00:00:00Z",
    },
    {
      id: "prj_work",
      name: "Work",
      kind: "standard" as const,
      createdAt: "2025-01-02T00:00:00Z",
    },
  ],
  activeId: PERSONAL_PROJECT_ID,
};

const originalProjectSeams = { ...projectSeams };
const originalVaultsSeams = { ...vaultsSeams };
const originalHooks = { ...vaultHooksSeams };
const switchVault = vi.fn();
const sealNewVault = vi.fn();
const removeVault = vi.fn();
interface StatusHolder {
  current: "empty" | "locked" | "unlocked";
}
const status: StatusHolder = { current: "empty" };

beforeEach(() => {
  Object.assign(projectSeams, {
    projectsState: () => state,
    subscribeProjects: () => () => {},
    activeProject: () => state.projects[0],
  });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...vaultStore.getSnapshot(), status: status.current }),
  });
  status.current = "empty";
  switchVault.mockReset().mockResolvedValue("locked");
  sealNewVault.mockReset().mockResolvedValue(state.projects[1]);
  removeVault.mockReset().mockResolvedValue(undefined);
  Object.assign(vaultsSeams, { switchVault, sealNewVault, removeVault });
});

afterEach(() => {
  cleanup();
  Object.assign(projectSeams, originalProjectSeams);
  Object.assign(vaultsSeams, originalVaultsSeams);
  Object.assign(vaultHooksSeams, originalHooks);
});

describe("Settings → Vaults", () => {
  it("lists the vaults and offers delete only where it is safe", () => {
    render(<VaultsPanel />);
    expect(
      screen.getByRole("heading", { name: "Vaults on this device" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete vault Work" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Delete vault personal/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Delete vault guest/ }),
    ).toBeNull();
  });

  it("asks in a sheet before it deletes, and only then removes", async () => {
    render(<VaultsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete vault Work" }));
    expect(removeVault).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete a vault" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete vault Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete vault" }));
    await waitFor(() => expect(removeVault).toHaveBeenCalledWith("prj_work"));
  });

  it("keeps the creation form off the page until the head's key opens it", () => {
    render(<VaultsPanel />);
    expect(screen.queryByLabelText("Name")).toBeNull();
    const key = screen.getByRole("button", { name: "Seal a new vault" });
    expect(key.closest(".panel__head")).not.toBeNull();
    fireEvent.click(key);
    expect(
      screen.getByRole("dialog", { name: "Seal a new vault" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("seals a new vault with its own key while nothing is open", async () => {
    render(<VaultsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Seal a new vault" }));
    expect(screen.queryByRole("radiogroup", { name: "Key" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Seal vault" }));
    await waitFor(() =>
      expect(sealNewVault).toHaveBeenCalledWith("Side", { shareKey: false }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers to share the open vault's key, and says what that buys", async () => {
    status.current = "unlocked";
    render(<VaultsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Seal a new vault" }));
    expect(
      screen.getByText("with this vault's key, no extra prompt"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Its own key" }));
    expect(
      screen.getByText("with a passkey, PIN or password of its own"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "This vault's key" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Seal vault" }));
    await waitFor(() =>
      expect(sealNewVault).toHaveBeenCalledWith("Side", { shareKey: true }),
    );
  });

  it("pressing a row switches, and a failure is said out loud", async () => {
    switchVault.mockRejectedValue(new Error("different key"));
    render(<VaultsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Work/ }));
    await waitFor(() => expect(switchVault).toHaveBeenCalledWith("prj_work"));
    expect(
      await screen.findByRole("img", { name: "different key" }),
    ).toBeTruthy();
    await expectInTray("different key");
  });
});
