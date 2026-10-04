/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../bindings/identity.js";
import { gestureLimits } from "../lib/gestures.js";
import { matchMediaFor } from "../lib/use-narrow.test-fake.js";

const orgs = vi.hoisted(() => ({
  listOrgMemberships: vi.fn(),
}));

import { orgSeams } from "@opensesame/app-core/lib/orgs.js";
Object.assign(orgSeams, { listOrgMemberships: orgs.listOrgMemberships });

import { identitySeams } from "@opensesame/app-core/lib/identity.js";
Object.assign(identitySeams, {
  currentSession: () => null,
  identityBase: () => "http://127.0.0.1:18788",
});
Object.assign(identityHookSeams, { useIdentitySession: () => null });

import {
  GUEST_PROFILE_ID,
  setActiveOrgProfileId,
} from "@opensesame/app-core/lib/orgs.js";
import { AccountSwitcher } from "./AccountSwitcher.js";

function renderSwitcher() {
  return render(
    <MemoryRouter>
      <AccountSwitcher />
    </MemoryRouter>,
  );
}

function openMenu() {
  const toggle = document.querySelector(".account-switcher .prompt__seg");
  if (!toggle) throw new Error("account switcher toggle not rendered");
  fireEvent.click(toggle);
}

function pointer(type: string, pointerType = "touch"): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: 4, clientY: 4 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

describe("AccountSwitcher — the glyph a phone draws for the name", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setActiveOrgProfileId(GUEST_PROFILE_ID);
    orgs.listOrgMemberships.mockReset();
    identityHookSeams.useIdentitySession = () => null;
    identitySeams.currentSession = () => null;
    orgs.listOrgMemberships.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function toggle(): HTMLElement {
    const el = document.querySelector<HTMLElement>(
      ".account-switcher .prompt__seg",
    );
    if (!el) throw new Error("account switcher toggle not rendered");
    return el;
  }

  it("names the control for assistive tech and draws the person's dots beside the name", () => {
    renderSwitcher();
    const seg = toggle();
    expect(seg.getAttribute("aria-label")).toBe(
      seg.querySelector(".prompt__name")?.textContent,
    );
    expect(seg.querySelector("svg.prompt__glyph")).not.toBeNull();
    expect(seg.getAttribute("title")).toBe("Switch account");
  });

  it("wears the organization's face while one is active, and the person's otherwise", async () => {
    orgs.listOrgMemberships.mockResolvedValue([
      {
        id: "org_acme",
        slug: "acme",
        displayName: "Acme",
        role: "member",
        state: "active",
      },
    ]);
    const session = {
      principalId: "prn_8f3c",
      accessToken: "tok",
      issuerOrigin: "http://127.0.0.1:18788",
    };
    identityHookSeams.useIdentitySession = () => session;
    renderSwitcher();
    const face = () => toggle().querySelector(".glyph__on")?.getAttribute("d");
    const person = face();
    act(() => setActiveOrgProfileId("org_acme"));
    openMenu();
    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".account-switcher__item")].some(
          (el) => el.textContent === "Acme",
        ),
      ).toBe(true),
    );
    const row = [...document.querySelectorAll(".account-switcher__item")].find(
      (el) => el.textContent === "Acme",
    );
    expect(face()).not.toBe(person);
    expect(row?.querySelector(".glyph__on")?.getAttribute("d")).toBe(face());
  });

  it("a finger held on it opens the profiles by name, and the lift does not close them", () => {
    vi.useFakeTimers();
    renderSwitcher();
    const seg = toggle();
    act(() => {
      seg.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(screen.getByText("Accounts")).toBeTruthy();
    fireEvent.click(seg);
    expect(screen.getByText("Accounts")).toBeTruthy();
    fireEvent.click(seg);
    expect(screen.queryByText("Accounts")).toBeNull();
  });

  it("keeps the profiles open when the browser aims the lift's click at the backdrop that appeared under the finger", () => {
    vi.useFakeTimers();
    renderSwitcher();
    const seg = toggle();
    act(() => {
      seg.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    const backdrop = document.querySelector(".account-switcher__backdrop");
    if (!backdrop) throw new Error("no backdrop");
    fireEvent.click(backdrop);
    expect(screen.getByText("Accounts")).toBeTruthy();
    act(() => {
      backdrop.dispatchEvent(pointer("pointerdown"));
    });
    fireEvent.click(backdrop);
    expect(screen.queryByText("Accounts")).toBeNull();
  });

  it("answers a touch long-press's own contextmenu with the profiles, not the session menu", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(true));
    const session = vi.fn();
    render(
      <MemoryRouter>
        <div onContextMenu={session}>
          <AccountSwitcher />
        </div>
      </MemoryRouter>,
    );
    expect(fireEvent.contextMenu(toggle())).toBe(false);
    expect(session).not.toHaveBeenCalled();
    expect(screen.getByText("Accounts")).toBeTruthy();
  });

  it("leaves a mouse's right-click to the session menu", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(false));
    const session = vi.fn();
    render(
      <MemoryRouter>
        <div onContextMenu={session}>
          <AccountSwitcher />
        </div>
      </MemoryRouter>,
    );
    fireEvent.contextMenu(toggle());
    expect(session).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Accounts")).toBeNull();
  });
});

describe("AccountSwitcher — where the name is drawn, nothing changes", () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    sessionStorage.clear();
    setActiveOrgProfileId(GUEST_PROFILE_ID);
    orgs.listOrgMemberships.mockResolvedValue([]);
    identityHookSeams.useIdentitySession = () => null;
    // The rail draws the name: `glyph.css` hides the glyph there.
    style = document.createElement("style");
    style.textContent = ".prompt__glyph { display: none; }";
    document.head.append(style);
  });
  afterEach(() => {
    style.remove();
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("leaves a touch long-press's contextmenu to the session menu, as before", () => {
    vi.stubGlobal("matchMedia", matchMediaFor(true));
    const session = vi.fn();
    render(
      <MemoryRouter>
        <div onContextMenu={session}>
          <AccountSwitcher />
        </div>
      </MemoryRouter>,
    );
    const seg = document.querySelector(".account-switcher .prompt__seg");
    if (!seg) throw new Error("no segment");
    fireEvent.contextMenu(seg);
    expect(session).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Accounts")).toBeNull();
  });

  it("does not take a held finger for the switcher either", () => {
    vi.useFakeTimers();
    renderSwitcher();
    const seg = document.querySelector(".account-switcher .prompt__seg");
    if (!seg) throw new Error("no segment");
    act(() => {
      seg.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(gestureLimits.longPressMs + 10);
    });
    expect(screen.queryByText("Accounts")).toBeNull();
    fireEvent.click(seg);
    expect(screen.getByText("Accounts")).toBeTruthy();
  });
});
