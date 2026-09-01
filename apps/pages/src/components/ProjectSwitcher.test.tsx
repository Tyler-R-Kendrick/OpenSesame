import { overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proj = vi.hoisted(() => ({
  state: {
    v: 1,
    projects: [
      {
        id: "personal",
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
    activeId: "personal",
  },
  createProject: vi.fn(),
  setActiveProject: vi.fn(),
  afterProjectChange: vi.fn(),
  continueAsGuest: vi.fn(),
  unlocked: false,
}));

import { projectSeams } from "../lib/projects.js";
Object.assign(projectSeams, {
  projectsState: () => proj.state,
  subscribeProjects: () => () => {},
  createProject: proj.createProject,
  setActiveProject: proj.setActiveProject,
});

import { vaultStore } from "../lib/vault/store.js";
vi.spyOn(vaultStore, "isUnlocked").mockImplementation(() => proj.unlocked);

import { guestAuthSeams } from "../lib/guest-auth.js";
Object.assign(guestAuthSeams, { continueAsGuest: proj.continueAsGuest });

import { ProjectSwitcher, projectSwitcherSeams } from "./ProjectSwitcher.js";
Object.assign(projectSwitcherSeams, {
  afterProjectChange: proj.afterProjectChange,
});

function renderSwitcher() {
  return render(
    <MemoryRouter>
      <ProjectSwitcher />
    </MemoryRouter>,
  );
}

function openMenu() {
  const toggle = document.querySelector(".project-switcher .prompt__seg");
  if (!toggle) throw new Error("switcher toggle not rendered");
  fireEvent.click(toggle);
}

/** A vault row inside the open menu, by its label. */
function vaultRow(label: string): HTMLElement {
  const matches = [...document.querySelectorAll(".vault-row__body")].filter(
    (el) => el.querySelector(".vault-row__name")?.textContent === label,
  );
  if (matches.length !== 1) throw new Error(`vault row ${label} not found`);
  return overlapCast(matches[0]);
}

describe("ProjectSwitcher — the @tomb prompt", () => {
  beforeEach(() => {
    proj.state.activeId = "personal";
    proj.unlocked = false;
    proj.createProject.mockReset();
    proj.setActiveProject.mockReset();
    proj.afterProjectChange.mockReset();
    proj.afterProjectChange.mockResolvedValue(undefined);
    proj.continueAsGuest.mockReset();
    proj.continueAsGuest.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("names the open vault and stays closed until asked", () => {
    renderSwitcher();
    expect(screen.queryByText("Vaults on this device")).toBeNull();
    expect(screen.getByRole("button", { name: "personal" })).toBeTruthy();
    openMenu();
    expect(screen.getByText("Vaults on this device")).toBeTruthy();
    // The cost of a switch is said where it is paid.
    expect(screen.getByText("switching locks this one")).toBeTruthy();
  });

  it("lists every vault on the device with guest as a peer", () => {
    renderSwitcher();
    openMenu();
    expect(vaultRow("personal")).toBeTruthy();
    expect(vaultRow("Work")).toBeTruthy();
    expect(vaultRow("guest")).toBeTruthy();
    expect(
      screen.getByText("no key · this tab only · nothing here is touched"),
    ).toBeTruthy();
  });

  it("switching vaults delegates to the store without reloading", async () => {
    proj.setActiveProject.mockResolvedValue(undefined);
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderSwitcher();
    openMenu();
    fireEvent.click(vaultRow("Work"));
    await waitFor(() =>
      expect(proj.setActiveProject).toHaveBeenCalledWith("prj_work"),
    );
    // Nothing on this device shares a key, so the swap locks.
    expect(proj.afterProjectChange).toHaveBeenCalledWith(false);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByText("Vaults on this device")).toBeNull();
  });

  it("the guest row locks and continues as guest (AGENTS.md §5)", async () => {
    renderSwitcher();
    openMenu();
    fireEvent.click(vaultRow("guest"));
    await waitFor(() => expect(proj.continueAsGuest).toHaveBeenCalledTimes(1));
    expect(proj.setActiveProject).not.toHaveBeenCalled();
  });

  it("surfaces swap failures instead of reloading", async () => {
    proj.setActiveProject.mockRejectedValue(new Error("vault busy"));
    renderSwitcher();
    openMenu();
    fireEvent.click(vaultRow("Work"));
    expect(await screen.findByText("vault busy")).toBeTruthy();
  });

  it("Escape and the backdrop both close the menu", () => {
    const { unmount } = renderSwitcher();
    openMenu();
    fireEvent.keyDown(screen.getByLabelText("Vaults on this device"), {
      key: "Escape",
    });
    expect(screen.queryByText("Vaults on this device")).toBeNull();
    unmount();

    const second = renderSwitcher();
    openMenu();
    fireEvent.click(
      overlapCast(
        second.container.querySelector(".project-switcher__backdrop"),
      ),
    );
    expect(screen.queryByText("Vaults on this device")).toBeNull();
  });

  it("seals a new vault from the draft name and activates it", async () => {
    proj.createProject.mockResolvedValue({
      id: "prj_side",
      name: "Side quest",
      kind: "standard",
      createdAt: "2025-01-03T00:00:00Z",
    });
    proj.setActiveProject.mockResolvedValue(undefined);
    renderSwitcher();
    openMenu();

    const submit = screen.getByRole("button", { name: "Seal a new vault" });
    expect(overlapCast(submit).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New vault name"), {
      target: { value: "Side quest" },
    });
    expect(overlapCast(submit).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(proj.createProject).toHaveBeenCalledWith("Side quest"),
    );
    expect(proj.setActiveProject).toHaveBeenCalledWith("prj_side");
    expect(proj.afterProjectChange).toHaveBeenCalledWith(false);
  });

  it("carries an open vault's key into a new one instead of reauthenticating", async () => {
    proj.unlocked = true;
    proj.createProject.mockResolvedValue({
      id: "prj_side",
      name: "Side quest",
      kind: "standard",
      createdAt: "2025-01-03T00:00:00Z",
    });
    proj.setActiveProject.mockResolvedValue(undefined);
    renderSwitcher();
    openMenu();
    fireEvent.change(screen.getByLabelText("New vault name"), {
      target: { value: "Side quest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Seal a new vault" }));
    await waitFor(() =>
      expect(proj.afterProjectChange).toHaveBeenCalledWith(true),
    );
  });

  it("reports create failures inline", async () => {
    proj.createProject.mockRejectedValue(new Error("name taken"));
    renderSwitcher();
    openMenu();
    fireEvent.change(screen.getByLabelText("New vault name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Seal a new vault" }));
    expect(await screen.findByText("name taken")).toBeTruthy();
  });

  it("never deletes from the prompt — that lives in Settings → Vaults", () => {
    renderSwitcher();
    openMenu();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Manage" })).toBeTruthy();
  });

  it("falls back to the first vault when the active id is unknown", () => {
    proj.state.activeId = "ghost";
    renderSwitcher();
    expect(screen.getByRole("button", { name: "personal" })).toBeTruthy();
  });

  it("falls back to the personal label when there are no projects at all", () => {
    const projects = proj.state.projects;
    proj.state.projects = [];
    proj.state.activeId = "ghost";
    renderSwitcher();
    expect(screen.getByRole("button", { name: "personal" })).toBeTruthy();
    proj.state.projects = projects;
  });

  it("clicking the toggle again closes the menu", () => {
    renderSwitcher();
    openMenu();
    expect(screen.getByText("Vaults on this device")).toBeTruthy();
    openMenu();
    expect(screen.queryByText("Vaults on this device")).toBeNull();
  });

  it("stringifies non-Error failures from swap and create", async () => {
    proj.setActiveProject.mockRejectedValue("plain string failure");
    renderSwitcher();
    openMenu();
    fireEvent.click(vaultRow("Work"));
    expect(await screen.findByText("plain string failure")).toBeTruthy();

    proj.createProject.mockRejectedValue("create blew up");
    fireEvent.change(screen.getByLabelText("New vault name"), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Seal a new vault" }));
    expect(await screen.findByText("create blew up")).toBeTruthy();
  });
});
