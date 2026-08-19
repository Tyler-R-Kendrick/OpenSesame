import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
        id: "work",
        name: "Work",
        kind: "standard" as const,
        createdAt: "2025-01-02T00:00:00Z",
      },
    ],
    activeId: "personal",
  },
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  setActiveProject: vi.fn(),
}));

vi.mock("../lib/projects.js", () => ({
  PERSONAL_PROJECT_ID: "personal",
  projectsState: () => proj.state,
  subscribeProjects: () => () => {},
  createProject: proj.createProject,
  deleteProject: proj.deleteProject,
  setActiveProject: proj.setActiveProject,
}));

import { ProjectSwitcher } from "./ProjectSwitcher.js";

function openMenu() {
  const toggle = document.querySelector(".project-switcher__button");
  if (!toggle) throw new Error("switcher toggle not rendered");
  fireEvent.click(toggle);
}

/** The row inside the open menu, not the switcher toggle itself. */
function menuItem(name: string): HTMLElement {
  const matches = screen
    .getAllByRole("button", { name })
    .filter((el) => el.className.includes("project-switcher__item"));
  if (matches.length !== 1) throw new Error(`menu item ${name} not found`);
  return matches[0] as HTMLElement;
}

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    proj.state.activeId = "personal";
    proj.createProject.mockReset();
    proj.deleteProject.mockReset();
    proj.setActiveProject.mockReset();
  });

  afterEach(cleanup);

  it("shows the active project and stays closed until asked", () => {
    render(<ProjectSwitcher />);
    expect(screen.queryByText("Projects")).toBeNull();
    openMenu();
    expect(screen.getByText("Projects")).toBeTruthy();
    const active = menuItem("Personal");
    expect(active.getAttribute("aria-current")).toBe("true");
    expect(active.className).toContain("is-active");
  });

  it("clicking the active project just closes the menu", () => {
    render(<ProjectSwitcher />);
    openMenu();
    fireEvent.click(menuItem("Personal"));
    expect(proj.setActiveProject).not.toHaveBeenCalled();
    expect(screen.queryByText("Projects")).toBeNull();
  });

  it("switching projects delegates to the store and reloads", async () => {
    proj.setActiveProject.mockResolvedValue(undefined);
    render(<ProjectSwitcher />);
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    await waitFor(() =>
      expect(proj.setActiveProject).toHaveBeenCalledWith("work"),
    );
  });

  it("surfaces swap failures instead of reloading", async () => {
    proj.setActiveProject.mockRejectedValue(new Error("vault busy"));
    render(<ProjectSwitcher />);
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(await screen.findByText("vault busy")).toBeTruthy();
  });

  it("Escape and the backdrop both close the menu", () => {
    const { container, unmount } = render(<ProjectSwitcher />);
    openMenu();
    fireEvent.keyDown(screen.getByLabelText("Projects"), { key: "Escape" });
    expect(screen.queryByText("Projects")).toBeNull();
    unmount();

    const second = render(<ProjectSwitcher />);
    openMenu();
    fireEvent.click(
      second.container.querySelector(".project-switcher__backdrop") as Element,
    );
    expect(screen.queryByText("Projects")).toBeNull();
    expect(container).toBeTruthy();
  });

  it("creates a project from the draft name and activates it", async () => {
    proj.createProject.mockResolvedValue({
      id: "side",
      name: "Side quest",
      kind: "standard",
      createdAt: "2025-01-03T00:00:00Z",
    });
    proj.setActiveProject.mockResolvedValue(undefined);
    render(<ProjectSwitcher />);
    openMenu();

    const submit = screen.getByRole("button", { name: "Create project" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New project name"), {
      target: { value: "Side quest" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(proj.createProject).toHaveBeenCalledWith("Side quest"),
    );
    expect(proj.setActiveProject).toHaveBeenCalledWith("side");
  });

  it("reports create failures inline", async () => {
    proj.createProject.mockRejectedValue(new Error("name taken"));
    render(<ProjectSwitcher />);
    openMenu();
    fireEvent.change(screen.getByLabelText("New project name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("name taken")).toBeTruthy();
  });

  it("arms delete before removing a non-personal, non-active project", async () => {
    proj.deleteProject.mockResolvedValue(undefined);
    render(<ProjectSwitcher />);
    openMenu();

    // The personal project and the active project never get a delete button.
    expect(
      screen.queryByRole("button", { name: "Delete project Personal" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete project Work" }),
    );
    const confirm = screen.getByRole("button", { name: "Really delete?" });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(proj.deleteProject).toHaveBeenCalledWith("work"),
    );
  });

  it("keeps the project when delete fails", async () => {
    proj.deleteProject.mockRejectedValue(new Error("still unlocked"));
    render(<ProjectSwitcher />);
    openMenu();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete project Work" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));
    expect(await screen.findByText("still unlocked")).toBeTruthy();
  });

  it("falls back to the first project when the active id is unknown", () => {
    proj.state.activeId = "ghost";
    render(<ProjectSwitcher />);
    expect(screen.getByRole("button", { name: /Personal/ })).toBeTruthy();
  });

  it("falls back to the Personal label when there are no projects at all", () => {
    const projects = proj.state.projects;
    proj.state.projects = [];
    proj.state.activeId = "ghost";
    render(<ProjectSwitcher />);
    expect(screen.getByRole("button", { name: /Personal/ })).toBeTruthy();
    proj.state.projects = projects;
  });

  it("clicking the toggle again closes the menu", () => {
    render(<ProjectSwitcher />);
    openMenu();
    expect(screen.getByText("Projects")).toBeTruthy();
    openMenu();
    expect(screen.queryByText("Projects")).toBeNull();
  });

  it("stringifies non-Error failures from swap, create, and delete", async () => {
    proj.setActiveProject.mockRejectedValue("plain string failure");
    render(<ProjectSwitcher />);
    openMenu();
    fireEvent.click(menuItem("Work"));
    expect(await screen.findByText("plain string failure")).toBeTruthy();

    proj.createProject.mockRejectedValue("create blew up");
    fireEvent.change(screen.getByLabelText("New project name"), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("create blew up")).toBeTruthy();

    proj.deleteProject.mockRejectedValue("delete blew up");
    fireEvent.click(
      screen.getByRole("button", { name: "Delete project Work" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));
    expect(await screen.findByText("delete blew up")).toBeTruthy();
  });

  it("never offers delete for the active project, even when non-personal", () => {
    proj.state.activeId = "work";
    render(<ProjectSwitcher />);
    openMenu();
    expect(
      screen.queryByRole("button", { name: "Delete project Work" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete project Personal" }),
    ).toBeNull();
  });
});
