/** @vitest-environment jsdom */

/**
 * Who takes Escape while a tour is live (ADR 0163 §3).
 *
 * The shell keymap and the coach are both window capture listeners, so the
 * order they were registered in must not decide anything. Here the keymap is
 * registered before the coach mounts, which is the order every tour that
 * stays on its route meets in the app.
 */

import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  type VaultKeymapTarget,
  registerVaultKeymap,
} from "../../lib/keymap-targets.js";
import { createKeymapHandler } from "../../lib/keymap.js";
import { usePaneEscape } from "../../lib/pane-escape.js";
import {
  disposeSupport,
  mountSupport,
  openPanel,
  tutorialCard,
  walkthrough,
} from "../__tests__/a11y/harness.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  disposeSupport();
});

/** A keymap listener on the window, before anything else is mounted. */
function shellKeymap(): string[] {
  const acted: string[] = [];
  const record = (name: string) => () => acted.push(name);
  const target: VaultKeymapTarget = {
    next: record("next"),
    previous: record("previous"),
    first: record("first"),
    last: record("last"),
    enter: record("enter"),
    parent: record("parent"),
    activate: record("activate"),
    search: record("search"),
    closeSearch: record("closeSearch"),
    copySecret: record("copySecret"),
    copyUsername: record("copyUsername"),
    edit: record("edit"),
    trash: record("trash"),
    create: record("create"),
    favorite: record("favorite"),
    share: record("share"),
  };
  cleanups.push(registerVaultKeymap(target));
  const keymap = createKeymapHandler({
    navigate: (path) => acted.push(`navigate:${path}`),
    showHelp: record("help"),
  });
  window.addEventListener("keydown", keymap, true);
  cleanups.push(() => window.removeEventListener("keydown", keymap, true));
  return acted;
}

async function startTour() {
  const user = userEvent.setup();
  const harness = mountSupport({
    agent: fakeAgentAlwaysUnavailable("no_local_model"),
    transport: "none",
    targets: ["shell.lock"],
  });
  await openPanel(user);
  await user.click(walkthrough("Lock the vault"));
  const card = await tutorialCard();
  return { user, harness, card };
}

const tourOpen = () => screen.queryByRole("dialog", { name: /^Tutorial:/ });

describe("Escape with the shell keymap registered first", () => {
  it("leaves the tour from the card, and the keymap does not act", async () => {
    const acted = shellKeymap();
    const { card } = await startTour();
    const next = screen.getByRole("button", { name: /^Next/ });
    next.focus();
    expect(card.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(next, { key: "Escape" });
    await waitFor(() => expect(tourOpen()).toBeNull());
    expect(acted).toEqual([]);
  });

  it("leaves the tour from the lit control", async () => {
    const acted = shellKeymap();
    const { harness } = await startTour();
    const lit = harness.fixtures.element("shell.lock");
    lit.focus();

    fireEvent.keyDown(lit, { key: "Escape" });
    await waitFor(() => expect(tourOpen()).toBeNull());
    expect(acted).toEqual([]);
  });
});

describe("Escape under an open surface", () => {
  function openSheet(): HTMLButtonElement {
    const layer = document.createElement("div");
    layer.className = "sheet-layer";
    const sheet = document.createElement("section");
    sheet.className = "sheet";
    const close = document.createElement("button");
    sheet.appendChild(close);
    layer.appendChild(sheet);
    document.body.appendChild(layer);
    cleanups.push(() => layer.remove());
    return close;
  }

  it("lets the sheet take it first, and the tour stays", async () => {
    shellKeymap();
    const { harness } = await startTour();
    const close = openSheet();
    close.focus();
    const seen: boolean[] = [];
    const watch = (event: KeyboardEvent) => seen.push(event.defaultPrevented);
    window.addEventListener("keydown", watch);
    cleanups.push(() => window.removeEventListener("keydown", watch));

    fireEvent.keyDown(close, { key: "Escape" });
    expect(tourOpen()).not.toBeNull();
    expect(seen).toEqual([false]);

    // Outside the sheet, with the page's control focused, the sheet still owns it.
    harness.fixtures.element("shell.lock").focus();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(tourOpen()).not.toBeNull();
  });

  it("still leaves from the card itself, whatever is open", async () => {
    shellKeymap();
    await startTour();
    openSheet();
    const next = screen.getByRole("button", { name: /^Next/ });
    fireEvent.keyDown(next, { key: "Escape" });
    await waitFor(() => expect(tourOpen()).toBeNull());
  });

  it("lets an open context menu take it", async () => {
    await startTour();
    const menu = document.createElement("div");
    menu.className = "ctxmenu";
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    cleanups.push(() => menu.remove());

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(tourOpen()).not.toBeNull();
  });
});

describe("Escape on a pane, with the page's own pane-escape registered first", () => {
  it("leaves the tour instead of being consumed by a pane with nothing to close", async () => {
    const pane = document.createElement("main");
    pane.tabIndex = -1;
    document.body.appendChild(pane);
    cleanups.push(() => pane.remove());
    const mounted = renderHook(() => usePaneEscape());
    cleanups.push(() => mounted.unmount());
    await startTour();
    pane.focus();

    fireEvent.keyDown(pane, { key: "Escape" });
    await waitFor(() => expect(tourOpen()).toBeNull());
  });
});
