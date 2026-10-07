import { observeGuideTarget } from "@opensesame/app-core/tutorial/registry/targets.js";
/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { Route, Routes, useNavigationType } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerContributedShell,
  renderShell,
  resetShellRender,
  vault,
} from "../../components/app-shell.test-harness.js";
import { ContextMenuLayer } from "../../components/context-menu/ContextMenuLayer.js";
import {
  closeContextMenu,
  contextMenuSnapshot,
} from "../../components/context-menu/menu-model.js";
import { gestureLimits } from "../../lib/gestures.js";
import { stubScreen } from "../../lib/use-narrow.test-support.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { VaultSection } from "../VaultSection.js";
import { SLIDE_ENTER } from "./add-slide.js";
import "./commands.test-support.js";
import { vaultTreeSeams } from "./VaultTree.js";
import { makeAccount } from "./section-items.test-support.js";

Object.assign(vaultHooksSeams, { useCopySecret: () => vi.fn() });
Object.assign(vaultTreeSeams, {
  activeTomb: () => "personal",
  loadCollapsed: async (): Promise<string[]> => [],
  saveCollapsed: async () => undefined,
});

/** Says how the current entry was arrived at, for the tests to read. */
function Arrival() {
  return <output data-testid="arrival">{useNavigationType()}</output>;
}

/** The vault section inside the real shell, so the Add button is the real one. */
function renderVault(path: string) {
  return renderShell(
    path,
    <>
      <ContextMenuLayer />
      <Routes>
        <Route
          path="/vault"
          element={
            <>
              <VaultSection />
              <Arrival />
            </>
          }
        >
          <Route index element={<div>welcome pane</div>} />
          <Route path=":itemId" element={<div>an item</div>} />
        </Route>
      </Routes>
    </>,
  );
}

/**
 * A pointer event jsdom will dispatch, carrying what the slide reads. jsdom has
 * no PointerEvent, so this is a MouseEvent with the pointer's own fields.
 */
type PointerAt = Readonly<{ y: number; id?: number }>;

function pointer(type: string, init: PointerAt): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: init.y,
  });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  Object.defineProperty(event, "pointerId", { value: init.id ?? 1 });
  return event;
}

describe("holding the Add button on a phone", () => {
  let revoke: readonly (() => void)[] = [];
  beforeEach(() => {
    revoke = registerContributedShell();
    vault.items = [makeAccount({ id: "itm_1", name: "GitHub" })];
    vault.folders = [];
    stubScreen({ narrow: true, coarse: true });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    resetShellRender();
    for (const undo of revoke) undo();
    vi.unstubAllGlobals();
  });

  const plus = () => screen.getByRole("link", { name: "New item" });
  const zone = (way: "up" | "down") =>
    document.querySelector<HTMLElement>(`.add-slide__zone--${way}`);
  const labels = () =>
    [...document.querySelectorAll(".add-slide__label")].map(
      (label) => label.textContent,
    );
  const lit = () =>
    [...document.querySelectorAll('.add-slide__zone[data-active="true"]')].map(
      (node) =>
        node.classList.contains("add-slide__zone--up") ? "up" : "down",
    );
  /** A touch that lands on the + and is held long enough to arm the slide. */
  function hold(y = 500) {
    act(() => {
      plus().dispatchEvent(pointer("pointerdown", { y }));
    });
    act(() => {
      vi.advanceTimersByTime(gestureLimits.longPressMs + 20);
    });
  }
  const move = (y: number) =>
    act(() => {
      plus().dispatchEvent(pointer("pointermove", { y }));
    });
  const lift = (y: number) =>
    act(() => {
      plus().dispatchEvent(pointer("pointerup", { y }));
    });

  it("draws the drag area only once held, naming Import above and Export below", () => {
    renderVault("/vault");
    act(() => {
      plus().dispatchEvent(pointer("pointerdown", { y: 500 }));
    });
    expect(document.querySelector(".add-slide")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(gestureLimits.longPressMs + 20);
    });
    expect(labels()).toEqual(["Import items", "Export items"]);
    expect(zone("up")).not.toBeNull();
    expect(zone("down")).not.toBeNull();
    // Nothing is chosen until the finger is over a zone.
    expect(lit()).toEqual([]);
    // Never a menu: the hold is the slide's.
    expect(contextMenuSnapshot()).toBeNull();
    lift(500);
    expect(document.querySelector(".add-slide")).toBeNull();
  });

  it("inks the zone the finger is over, and lets go of it when the finger leaves", () => {
    renderVault("/vault");
    hold();
    move(500 - SLIDE_ENTER + 4);
    expect(lit()).toEqual([]);
    move(500 - SLIDE_ENTER - 20);
    expect(lit()).toEqual(["up"]);
    move(500 + SLIDE_ENTER + 20);
    expect(lit()).toEqual(["down"]);
    move(500);
    expect(lit()).toEqual([]);
  });

  it("lifting on Import starts the file picker, and the lift does not follow the +", () => {
    renderVault("/vault");
    const picker = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    hold();
    move(500 - SLIDE_ENTER - 30);
    lift(500 - SLIDE_ENTER - 30);
    expect(picker).toHaveBeenCalledOnce();
    expect(document.querySelector(".add-slide")).toBeNull();
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      plus().dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByTestId("arrival").textContent).toBe("POP");
  });

  it("lifting on Export opens the export sheet", async () => {
    const real = vaultHooksSeams.useVault;
    vaultHooksSeams.useVault = () => ({
      ...real(),
      tomb: "personal",
      header: null,
      status: "unlocked",
    });
    renderVault("/vault");
    hold();
    move(500 + SLIDE_ENTER + 30);
    lift(500 + SLIDE_ENTER + 30);
    vi.useRealTimers();
    expect(
      await screen.findByRole("dialog", { name: "Export encrypted vault" }),
    ).toBeTruthy();
    vaultHooksSeams.useVault = real;
  });

  it("lifting anywhere else chooses nothing", () => {
    renderVault("/vault");
    const picker = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    hold();
    move(500 - SLIDE_ENTER - 30);
    move(500);
    lift(500);
    expect(picker).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a finger that wanders before the hold arms is a scroll, not a hold", () => {
    renderVault("/vault");
    act(() => {
      plus().dispatchEvent(pointer("pointerdown", { y: 500 }));
    });
    move(500 - gestureLimits.longPressSlop - 6);
    act(() => {
      vi.advanceTimersByTime(gestureLimits.longPressMs + 20);
    });
    expect(document.querySelector(".add-slide")).toBeNull();
  });

  it("a tap is still one tap: no drag area, and the click follows the +", () => {
    renderVault("/vault");
    act(() => {
      plus().dispatchEvent(pointer("pointerdown", { y: 500 }));
      plus().dispatchEvent(pointer("pointerup", { y: 500 }));
    });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      plus().dispatchEvent(click);
    });
    expect(document.querySelector(".add-slide")).toBeNull();
    // The Link took it: a client-side navigation, not a swallowed lift.
    expect(screen.getByTestId("arrival").textContent).toBe("PUSH");
  });

  it("a held finger never opens the page's menu or the Add menu", () => {
    renderVault("/vault");
    hold();
    fireEvent.contextMenu(plus());
    expect(contextMenuSnapshot()).toBeNull();
    lift(500);
    fireEvent.contextMenu(plus());
    expect(contextMenuSnapshot()).toBeNull();
  });

  it("a keyboard or a mouse, which cannot slide, gets the entries as a menu", () => {
    renderVault("/vault");
    fireEvent.contextMenu(plus());
    expect(contextMenuSnapshot()?.label).toBe("Add actions");
    expect(
      contextMenuSnapshot()
        ?.groups.flat()
        .map((entry) => entry.label),
    ).toEqual(["Import items", "Export items", "Open a claim"]);
    closeContextMenu();
  });

  it("lists Import before Export, each a flow the button mounts", () => {
    renderVault("/vault");
    fireEvent.contextMenu(plus());
    const entries = contextMenuSnapshot()?.groups.flat() ?? [];
    expect(entries.map((entry) => entry.id)).toEqual([
      "import",
      "export",
      "claim",
    ]);
    expect(
      document.querySelector('input[type="file"][aria-label]'),
    ).not.toBeNull();
    closeContextMenu();
  });
});

describe("the Add button's slide, edge cases", () => {
  beforeEach(() => {
    stubScreen({ narrow: true, coarse: true });
    vault.items = [makeAccount({ id: "itm_1", name: "GitHub" })];
    vault.folders = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    resetShellRender();
    vi.unstubAllGlobals();
  });
  const plus = () => screen.getByRole("link", { name: "New item" });
  const fire = (type: string, y: number, id = 1) =>
    act(() => {
      plus().dispatchEvent(pointer(type, { y, id }));
    });
  const armed = () => {
    fire("pointerdown", 500);
    act(() => {
      vi.advanceTimersByTime(gestureLimits.longPressMs + 20);
    });
  };

  it("a second finger lifting does not choose what the first one is over", () => {
    renderVault("/vault");
    const picker = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    armed();
    fire("pointermove", 500 - SLIDE_ENTER - 30);
    fire("pointerup", 500 - SLIDE_ENTER - 30, 2);
    expect(picker).not.toHaveBeenCalled();
    expect(document.querySelector(".add-slide")).not.toBeNull();
    fire("pointerup", 500 - SLIDE_ENTER - 30);
    expect(picker).toHaveBeenCalledOnce();
  });

  it("a click the browser never made does not swallow a later one", () => {
    renderVault("/vault");
    armed();
    fire("pointerup", 500);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      plus().dispatchEvent(click);
    });
    // The Link took it: a client-side navigation, not a swallowed lift.
    expect(screen.getByTestId("arrival").textContent).toBe("PUSH");
  });

  it("choosing from the menu tells the guide, as the slide does", async () => {
    renderVault("/vault");
    const controller = new AbortController();
    const settled = vi.fn();
    void observeGuideTarget("vault.import", "activate", controller.signal)
      .then(settled)
      .catch(() => undefined);
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    fireEvent.contextMenu(plus());
    const entry = contextMenuSnapshot()
      ?.groups.flat()
      .find((candidate) => candidate.id === "import");
    act(() => entry?.run());
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect(settled).toHaveBeenCalled();
    closeContextMenu();
  });
});
