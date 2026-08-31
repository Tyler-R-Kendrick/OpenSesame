/** @vitest-environment jsdom */

/**
 * Where the caret goes, and what Escape costs.
 *
 * The panel is not a native `<dialog>` — the shared sheet layer traps rather
 * than inerting — so containment, restoration and the Escape contract are all
 * behaviour this app wrote itself, and all of it has a second claimant: the
 * vault keymap owns every unmodified key on the page underneath. Escape in
 * particular is `closeSearch` there, and one missing bail-out would mean
 * dismissing a help sheet quietly reached into the vault behind it.
 */

import { fakeAgentAnswering } from "@opensesame/support-agent";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { VaultKeymapTarget } from "../../../lib/keymap.js";
import {
  createKeymapHandler,
  registerVaultKeymap,
} from "../../../lib/keymap.js";
import {
  type SupportHarness,
  type TestUser,
  disposeSupport,
  launcher,
  mountSupport,
  openPanel,
  reachable,
} from "./harness.js";

/**
 * The real vault keymap, wired the way `AppShell` wires it — capture phase on
 * `window`, so it sees every key before the sheet's own handler does. Each
 * action records itself, and nothing else in the vault is reachable from here,
 * so an empty log is proof the key never became a vault action.
 */
type VaultUnderneath = {
  /** Every vault action the keymap fired, in order. */
  readonly acted: readonly string[];
  stop(): void;
};

function vaultUnderneath(): VaultUnderneath {
  const acted: string[] = [];
  const record = (name: string) => () => {
    acted.push(name);
  };
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
  const release = registerVaultKeymap(target);
  const keymap = createKeymapHandler({
    navigate: (path) => acted.push(`navigate:${path}`),
    showHelp: record("showHelp"),
  });
  window.addEventListener("keydown", keymap, true);
  return {
    acted,
    stop: () => {
      window.removeEventListener("keydown", keymap, true);
      release();
    },
  };
}

async function ask(user: TestUser, question: string): Promise<void> {
  const field = await screen.findByLabelText<HTMLInputElement>(
    "Ask about this screen",
  );
  await waitFor(() => expect(field.disabled).toBe(false));
  await user.type(field, question);
  await user.click(screen.getByRole("button", { name: "Ask" }));
}

function closeInside(sheet: HTMLElement): HTMLElement {
  return within(sheet).getByRole("button", { name: "Close" });
}

function scrim(sheet: HTMLElement): HTMLElement {
  const outside = screen
    .getAllByRole("button", { name: "Close" })
    .filter((node) => !sheet.contains(node));
  const found = outside[0];
  if (!found) throw new Error("the sheet layer rendered no scrim");
  return found;
}

afterEach(disposeSupport);

describe("support panel focus", () => {
  it("lands the caret on the dialog's own close control, not merely inside it", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    expect(document.activeElement).toBe(closeInside(sheet));
  });

  it("restores the launcher after Escape and after the scrim", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });

    const affordance = launcher();
    const sheet = await openPanel(user);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );
    expect(document.activeElement).toBe(affordance);

    const reopened = await openPanel(user);
    await user.click(scrim(reopened));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );
    expect(document.activeElement).toBe(affordance);
    expect(sheet.isConnected).toBe(false);
  });

  it("wraps Tab in both directions and pulls stray focus back in", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    const inside = reachable(sheet);
    const first = inside[0];
    const last = inside.at(-1);
    if (!first || !last) throw new Error("the sheet trapped nothing");
    expect(document.activeElement).toBe(first);

    // Backwards off the front lands on the back, not on the page behind.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);

    // Forwards off the back returns to the front.
    await user.tab();
    expect(document.activeElement).toBe(first);

    // Focus that got out — the scrim is a real button outside the dialog —
    // is taken back on the next Tab rather than left to walk the vault.
    scrim(sheet).focus();
    expect(sheet.contains(document.activeElement)).toBe(false);
    fireEvent.keyDown(scrim(sheet), { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });
});

describe("Escape and the vault underneath", () => {
  it("closes the sheet without the vault keymap acting, and without locking", async () => {
    const user = userEvent.setup();
    const vault = vaultUnderneath();
    let harness: SupportHarness | null = null;
    try {
      harness = mountSupport({ agent: fakeAgentAnswering("Still here.") });
      const sheet = await openPanel(user);
      await ask(user, "where is the lock");
      await within(sheet).findByText("Still here.");

      fireEvent.keyDown(closeInside(sheet), { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
      );

      // Escape reached the sheet and nothing else: no `closeSearch`, no
      // navigation, and nothing in the vault moved.
      expect(vault.acted).toEqual([]);
      // Closing is not locking. The engine, the model session and the
      // transcript all survive, which is the difference between dismissing a
      // sheet and dropping the keys.
      expect(harness.engine.destroyed()).toBe(false);
      expect(harness.engine.agent.destroyed()).toBe(false);
      expect(harness.clearedTargets()).toBe(0);

      await user.click(launcher());
      const reopened = await screen.findByRole("dialog", { name: "Support" });
      expect(within(reopened).getByText("Still here.")).toBeTruthy();
    } finally {
      vault.stop();
    }
  });

  it("keeps every other vault key from firing while the sheet is up", async () => {
    const user = userEvent.setup();
    const vault = vaultUnderneath();
    try {
      mountSupport({ agent: fakeAgentAnswering("Anything.") });

      // The control: with no sheet open the keymap is genuinely live, so the
      // silence asserted below is a bail-out rather than a dead listener.
      fireEvent.keyDown(document.body, { key: "n" });
      expect(vault.acted).toEqual(["create"]);

      const sheet = await openPanel(user);
      const anchor = closeInside(sheet);
      for (const key of ["n", "j", "/", "e", "x", "y", "?", "g"]) {
        fireEvent.keyDown(anchor, { key });
      }
      expect(vault.acted).toEqual(["create"]);
    } finally {
      vault.stop();
    }
  });
});
