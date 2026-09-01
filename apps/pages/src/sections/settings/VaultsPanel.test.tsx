import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERSONAL_PROJECT_ID, projectSeams } from "../../lib/projects.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { vaultStore } from "../../lib/vault/store.js";
import { vaultsSeams } from "../../lib/vaults.js";
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
const status = { current: "empty" as "empty" | "locked" | "unlocked" };

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

  it("arms delete in place and only then removes", async () => {
    render(<VaultsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete vault Work" }));
    expect(removeVault).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete vault Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete this vault" }));
    await waitFor(() => expect(removeVault).toHaveBeenCalledWith("prj_work"));
  });

  it("seals a new vault with its own key while nothing is open", async () => {
    render(<VaultsPanel />);
    expect(screen.queryByLabelText("Open it with this vault's key")).toBeNull();
    fireEvent.change(screen.getByLabelText("Seal a new vault"), {
      target: { value: "Side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(sealNewVault).toHaveBeenCalledWith("Side", { shareKey: false }),
    );
  });

  it("offers to share the open vault's key, and says what that buys", async () => {
    status.current = "unlocked";
    render(<VaultsPanel />);
    const share = screen.getByLabelText("Open it with this vault's key");
    expect(screen.getByText(/no extra prompt/)).toBeTruthy();
    fireEvent.click(share);
    expect(screen.getByText(/its own passkey, PIN or password/)).toBeTruthy();
    fireEvent.click(share);
    fireEvent.change(screen.getByLabelText("Seal a new vault"), {
      target: { value: "Side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(sealNewVault).toHaveBeenCalledWith("Side", { shareKey: true }),
    );
  });

  it("pressing a row switches, and a failure is said out loud", async () => {
    switchVault.mockRejectedValue(new Error("different key"));
    render(<VaultsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Work/ }));
    await waitFor(() => expect(switchVault).toHaveBeenCalledWith("prj_work"));
    expect(await screen.findByText("different key")).toBeTruthy();
  });
});
