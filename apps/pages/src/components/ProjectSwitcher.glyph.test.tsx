import { overlapCast } from "@opensesame/os-domain";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gestureLimits } from "../lib/gestures.js";
import { matchMediaFor } from "../lib/use-narrow.test-fake.js";

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

import { projectSeams } from "@opensesame/app-core/lib/projects.js";
Object.assign(projectSeams, {
  projectsState: () => proj.state,
  subscribeProjects: () => () => {},
  createProject: proj.createProject,
  setActiveProject: proj.setActiveProject,
});

import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
vi.spyOn(vaultStore, "isUnlocked").mockImplementation(() => proj.unlocked);

import { guestAuthSeams } from "@opensesame/app-core/lib/guest-auth.js";
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

/** A pointer event of the kind a finger sends, which jsdom has no class for. */
function pointer(type: string, pointerType = "touch"): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: 4, clientY: 4 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

/** The phone's top bar draws the glyph alone: `glyph.css` hides the name. */
function hideNames(): () => void {
  const style = document.createElement("style");
  style.textContent = ".prompt__name { display: none; }";
  document.head.append(style);
  return () => style.remove();
}

describe("ProjectSwitcher — the glyph a phone draws for the name", () => {
  let showNames = () => {};
  beforeEach(() => {
    proj.state.activeId = "personal";
    proj.unlocked = false;
    showNames = hideNames();
  });
  afterEach(() => {
    showNames();
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the name for assistive tech and draws the dots beside it", () => {
    renderSwitcher();
    const toggle = screen.getByRole("button", { name: "personal" });
    expect(toggle.querySelector(".prompt__name")?.textContent).toBe("personal");
    expect(toggle.querySelector("svg.prompt__glyph")).not.toBeNull();
    expect(toggle.getAttribute("title")).toBe("Switch vault");
  });

  it("gives each vault its own face, and the same face in the menu as at the prompt", () => {
    proj.state.activeId = "prj_work";
    renderSwitcher();
    const face = (root: ParentNode) =>
      root.querySelector(".glyph__on")?.getAttribute("d");
    const atPrompt = face(
      screen.getByRole("button", { name: /work/i, expanded: false }),
    );
    openMenu();
    const rows = [...document.querySelectorAll(".vault-row")];
    const faces = rows.map((row) => face(row));
    expect(new Set(faces).size).toBe(rows.length);
    const workRow = rows.find(
      (row) => row.querySelector(".vault-row__name")?.textContent === "Work",
    );
    if (!workRow) throw new Error("no Work row");
    expect(face(workRow)).toBe(atPrompt);
  });

  it("a finger held on it opens the list of vaults by name, and the lift does not close it", () => {
    vi.useFakeTimers();
    renderSwitcher();
    const toggle = screen.getByRole("button", { name: "personal" });
    act(() => {
      toggle.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(screen.getByLabelText("Vaults on this device")).toBeTruthy();
    expect(vaultRow("Work")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Vaults on this device")).toBeTruthy();
    // The next press is an ordinary one again.
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Vaults on this device")).toBeNull();
  });

  it("keeps the list open when the browser aims the lift's click at the backdrop that appeared under the finger", () => {
    vi.useFakeTimers();
    renderSwitcher();
    const toggle = screen.getByRole("button", { name: "personal" });
    act(() => {
      toggle.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    const backdrop = document.querySelector(".project-switcher__backdrop");
    if (!backdrop) throw new Error("no backdrop");
    fireEvent.click(backdrop);
    expect(screen.getByLabelText("Vaults on this device")).toBeTruthy();
    // A later press on the backdrop is a real dismissal.
    act(() => {
      backdrop.dispatchEvent(pointer("pointerdown"));
    });
    fireEvent.click(backdrop);
    expect(screen.queryByLabelText("Vaults on this device")).toBeNull();
  });

  it("lets a held finger pick another vault from the list", async () => {
    vi.useFakeTimers();
    renderSwitcher();
    const toggle = screen.getByRole("button", { name: "personal" });
    act(() => {
      toggle.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    vi.useRealTimers();
    fireEvent.click(vaultRow("Work"));
    await waitFor(() =>
      expect(proj.setActiveProject).toHaveBeenCalledWith("prj_work"),
    );
  });

  it("answers a touch long-press's own contextmenu with the list, not the session menu", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(true));
    const session = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <div onContextMenu={session}>
          <ProjectSwitcher />
        </div>
      </MemoryRouter>,
    );
    const toggle = screen.getByRole("button", { name: "personal" });
    const asked = fireEvent.contextMenu(toggle);
    expect(asked).toBe(false);
    expect(session).not.toHaveBeenCalled();
    expect(container.querySelector(".project-switcher__menu")).not.toBeNull();
  });

  it("leaves a mouse's right-click to the session menu", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(false));
    const session = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <div onContextMenu={session}>
          <ProjectSwitcher />
        </div>
      </MemoryRouter>,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "personal" }));
    expect(session).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".project-switcher__menu")).toBeNull();
  });
});

describe("ProjectSwitcher — where the name is drawn beside its glyph, nothing changes", () => {
  beforeEach(() => {
    proj.state.activeId = "personal";
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("draws the glyph and the name together, the mark first", () => {
    renderSwitcher();
    const toggle = screen.getByRole("button", { name: "personal" });
    const children = [...toggle.children].map((el) => el.getAttribute("class"));
    expect(children[0]).toContain("prompt__glyph");
    expect(toggle.querySelector("svg.prompt__glyph")).not.toBeNull();
    const name = toggle.querySelector(".prompt__name");
    if (!name) throw new Error("no name");
    expect(getComputedStyle(name).display).not.toBe("none");
  });

  it("leaves a touch long-press's contextmenu to the session menu, as before", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(true));
    const session = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <div onContextMenu={session}>
          <ProjectSwitcher />
        </div>
      </MemoryRouter>,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "personal" }));
    expect(session).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".project-switcher__menu")).toBeNull();
  });

  it("does not take a held finger for the switcher either", () => {
    vi.useFakeTimers();
    renderSwitcher();
    const toggle = screen.getByRole("button", { name: "personal" });
    act(() => {
      toggle.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(screen.queryByLabelText("Vaults on this device")).toBeNull();
    // …and the lift is an ordinary tap that opens it, as it always did.
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Vaults on this device")).toBeTruthy();
  });
});
