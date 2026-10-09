import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../bindings/identity.js";

import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  PERSONAL_PROJECT_ID,
  projectSeams,
} from "@opensesame/app-core/lib/projects.js";
import { vaultsSeams } from "@opensesame/app-core/lib/vaults.js";

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

import { identitySeams } from "@opensesame/app-core/lib/identity.js";
Object.assign(identitySeams, {
  identityBase: () => "",
});
Object.assign(identityHookSeams, {
  useIdentitySession: () => null,
});

import { federationSeams } from "@opensesame/app-core/lib/federation.js";
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
import { joinRoadDependencies } from "./join/JoinRoad.js";

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
  clearNotices();
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
    fireEvent.click(screen.getByRole("button", { name: "Create vault" }));
    await waitFor(() =>
      expect(sealNewVault).toHaveBeenCalledWith("Side", { shareKey: false }),
    );
    await waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1));
  });

  it("says why a switch failed and stays on the door", async () => {
    switchVault.mockRejectedValue(new Error("storage refused"));
    const onPicked = renderScreen();
    fireEvent.click(screen.getByText("project · 4f2a"));
    await waitFor(() =>
      expect(
        listNotices().some(
          (n) => n.kind === "status" && n.body.includes("storage refused"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByText("storage refused")).toBeNull();
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("offers to reset this browser beneath the list", () => {
    renderScreen();
    expect(
      screen.getByRole("button", { name: "Reset this browser?" }),
    ).toBeTruthy();
  });

  it("offers join beside the list, with no setup record required", () => {
    const openJoin = vi.fn();
    const previous = joinRoadDependencies.openJoin;
    joinRoadDependencies.openJoin = openJoin;
    try {
      renderScreen();
      fireEvent.click(screen.getByRole("button", { name: "Join a session" }));
      expect(openJoin).toHaveBeenCalledOnce();
    } finally {
      joinRoadDependencies.openJoin = previous;
    }
  });

  it("carries the sign-in tab beside the list", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("tab", { name: "Sign in" }));
    // The compiled-in road is the panel's own; the guest road is
    // the unlock form's footer, not a second copy in the panel.
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
  });
});

describe("VaultsScreen — where the keyboard lands", () => {
  it("lands on the first vault that can be opened, so Enter opens it", () => {
    renderScreen();
    const rows = screen.getAllByRole("button", { name: /personal|project/ });
    expect(document.activeElement).toBe(rows[0]);
  });

  it("moves to the name when sealing a new vault", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Seal a new vault/ }));
    expect(document.activeElement).toBe(
      screen.getByLabelText("Seal a new vault"),
    );
  });
});
