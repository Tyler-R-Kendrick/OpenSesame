import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERSONAL_PROJECT_ID, projectSeams } from "../lib/projects.js";
import { vaultsSeams } from "../lib/vaults.js";

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
      id: "prj_0000-4f2a",
      name: "prj_0000-4f2a",
      kind: "standard" as const,
      createdAt: "2025-01-02T00:00:00Z",
    },
  ],
  activeId: PERSONAL_PROJECT_ID,
};

const originalProjectSeams = { ...projectSeams };
const originalVaultsSeams = { ...vaultsSeams };
const switchVault = vi.fn();
const sealNewVault = vi.fn();

import { identitySeams } from "../lib/identity.js";
Object.assign(identitySeams, {
  identityBase: () => "",
  useIdentitySession: () => null,
});

import { federationSeams } from "../lib/federation.js";
Object.assign(federationSeams, {
  beginSignIn: () => Promise.resolve(),
  defaultUpstream: () => ({
    id: "shoo",
    displayName: "Shoo",
    issuer: "https://shoo.dev",
    accountKind: "Google",
  }),
  loadSession: () => null,
});

import { VaultsScreen } from "./VaultsScreen.js";

beforeEach(() => {
  Object.assign(projectSeams, {
    projectsState: () => state,
    subscribeProjects: () => () => {},
    activeProject: () => state.projects[0],
  });
  switchVault.mockReset().mockResolvedValue("locked");
  sealNewVault.mockReset().mockResolvedValue(state.projects[1]);
  Object.assign(vaultsSeams, { switchVault, sealNewVault });
});

afterEach(() => {
  cleanup();
  Object.assign(projectSeams, originalProjectSeams);
  Object.assign(vaultsSeams, originalVaultsSeams);
});

function renderScreen(onPicked = vi.fn()) {
  render(<VaultsScreen providers={[]} onPicked={onPicked} />);
  return onPicked;
}

describe("VaultsScreen — the front door", () => {
  it("lists every vault honestly, the guest road as a peer", () => {
    renderScreen();
    expect(screen.getByRole("heading", { name: "Vaults" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /personal/ })).toBeTruthy();
    // A sealed name is a secret: the id's tail stands in, and the row says so.
    expect(screen.getByText("project · 4f2a")).toBeTruthy();
    expect(screen.queryByText("prj_0000-4f2a")).toBeNull();
    expect(screen.getByRole("button", { name: /guest/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Seal a new vault/ }),
    ).toBeTruthy();
  });

  it("picking a vault switches and hands over to its unlock form", async () => {
    const onPicked = renderScreen();
    fireEvent.click(screen.getByText("project · 4f2a"));
    await waitFor(() =>
      expect(switchVault).toHaveBeenCalledWith("prj_0000-4f2a"),
    );
    await waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1));
  });

  it("the guest row is never withheld and opens as guest (AGENTS.md §5)", async () => {
    const onPicked = renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /guest/ }));
    await waitFor(() => expect(switchVault).toHaveBeenCalledWith("guest"));
    await waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1));
  });

  it("seals a new vault with its own key — nothing to share before unlock", async () => {
    const onPicked = renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Seal a new vault/ }));
    fireEvent.change(screen.getByLabelText("Seal a new vault"), {
      target: { value: "Side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(sealNewVault).toHaveBeenCalledWith("Side", { shareKey: false }),
    );
    await waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1));
  });

  it("says why a switch failed and stays on the door", async () => {
    switchVault.mockRejectedValue(new Error("storage refused"));
    const onPicked = renderScreen();
    fireEvent.click(screen.getByText("project · 4f2a"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("storage refused")).toBeTruthy();
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("carries the sign-in tab beside the list", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    expect(
      screen.getByRole("button", { name: /Continue as guest/ }),
    ).toBeTruthy();
  });
});
