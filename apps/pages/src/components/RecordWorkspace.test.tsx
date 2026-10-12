/** @vitest-environment jsdom */
import { resolveGuideTargetElement } from "@opensesame/app-core/tutorial/registry/targets.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentVaultTarget } from "../lib/keymap-targets.js";
import { NARROW_QUERY } from "../lib/use-narrow.js";
import { FakeMediaQueryList } from "../lib/use-narrow.test-fake.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { RecordWorkspace } from "./RecordWorkspace.js";

let narrow = false;

beforeEach(() => {
  narrow = false;
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      new FakeMediaQueryList(query, narrow && query === NARROW_QUERY),
  );
  const rect = new DOMRect();
  const rects: DOMRectList = {
    0: rect,
    length: 1,
    item: (index) => (index === 0 ? rect : null),
    [Symbol.iterator]: () => [rect][Symbol.iterator](),
  };
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(rects);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("CSS", { escape: (text: string) => text });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Records() {
  const location = useLocation();
  const id = location.hash.slice(1) || null;
  return (
    <>
      <output data-testid="location">
        {location.search}
        {location.hash}
      </output>
      <RecordWorkspace
        section="Identity"
        title="Agents"
        rootPath="/identity"
        listPath="/identity?view=agents"
        selectedId={id}
        detailOpen={location.search.includes("action=edit")}
        rows={[
          { id: "alpha", label: "Alpha", to: "/identity?view=agents#alpha" },
          { id: "beta", label: "Beta", to: "/identity?view=agents#beta" },
        ]}
        commands={
          <button type="button" aria-label="New agent">
            +
          </button>
        }
        status={<output data-testid="notice">Notice registration</output>}
      >
        <h1>{id}</h1>
      </RecordWorkspace>
    </>
  );
}
function start(path = "/identity?view=agents") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Records />
    </MemoryRouter>,
  );
}

it("previews records from the same listing movement commands as the vault", () => {
  start();
  act(() => currentVaultTarget()?.next());
  expect(screen.getByTestId("location").textContent).toBe("?view=agents#alpha");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("alpha");
  act(() => currentVaultTarget()?.next());
  expect(screen.getByTestId("location").textContent).toBe("?view=agents#beta");
  expect(
    screen
      .getByRole("tree", { name: "Agents items" })
      .getAttribute("aria-activedescendant"),
  ).toBe("record-Identity-beta");
});

it("moves the phone cursor without navigating until the record is opened", () => {
  narrow = true;
  start();
  act(() => currentVaultTarget()?.next());
  expect(screen.getByTestId("location").textContent).toBe("?view=agents");
  expect(
    screen
      .getByRole("tree", { name: "Agents items" })
      .getAttribute("aria-activedescendant"),
  ).toBe("record-Identity-alpha");
  act(() => currentVaultTarget()?.activate());
  expect(screen.getByTestId("location").textContent).toBe("?view=agents#alpha");
});

it("keeps an editor open when the list cursor moves", () => {
  start("/identity?view=agents&action=edit#alpha");
  act(() => currentVaultTarget()?.next());
  expect(screen.getByTestId("location").textContent).toBe(
    "?view=agents&action=edit#alpha",
  );
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("alpha");
});

it("keeps notice registration mounted before any record is selected", () => {
  start();
  expect(screen.getByTestId("notice").textContent).toBe("Notice registration");
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
});

it("exposes a guided phone Grant command through the visible add control", async () => {
  narrow = true;
  const grant = vi.fn();
  function GrantCommand() {
    const ref = useGuideTarget<HTMLButtonElement>("vault.create");
    return (
      <button
        ref={ref}
        type="button"
        aria-label="Grant identity share"
        style={{ display: "none" }}
        onClick={grant}
      >
        +
      </button>
    );
  }
  render(
    <MemoryRouter initialEntries={["/access/shares"]}>
      <RecordWorkspace
        section="Access"
        title="Identity shares"
        rootPath="/access"
        listPath="/access/shares"
        rows={[]}
        selectedId={null}
        createGuide="vault.create"
        commands={<GrantCommand />}
      />
    </MemoryRouter>,
  );
  const add = await waitFor(() => {
    const control = document.querySelector<HTMLButtonElement>(
      ".record-workspace__add",
    );
    expect(control).not.toBeNull();
    return control;
  });
  expect(resolveGuideTargetElement("vault.create")).toBe(add);
  if (!add) throw new Error("Missing phone creation control");
  fireEvent.click(add);
  expect(grant).toHaveBeenCalledTimes(1);
});

it("lands a phone route arrival on its empty listing without stealing focus when rows load", async () => {
  narrow = true;
  const workspace = (loaded: boolean) => (
    <MemoryRouter initialEntries={["/access?view=requests"]}>
      <RecordWorkspace
        section="Access"
        title="Requests"
        rootPath="/access"
        listPath="/access?view=requests"
        selectedId={null}
        rows={
          loaded
            ? [
                {
                  id: "pending",
                  label: "Pending",
                  to: "/access?view=requests#pending",
                },
              ]
            : []
        }
        commands={
          <button type="button" aria-label="New local request">
            +
          </button>
        }
      />
      <input aria-label="Other control" />
    </MemoryRouter>
  );
  const { rerender } = render(workspace(false));
  const listing = screen.getByRole("tree", { name: "Requests items" });
  await waitFor(() => expect(document.activeElement).toBe(listing));
  screen.getByLabelText("Other control").focus();
  rerender(workspace(true));
  await waitFor(() =>
    expect(screen.getByRole("treeitem", { name: "Pending" })).toBeTruthy(),
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Other control"));
});
