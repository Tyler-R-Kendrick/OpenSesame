/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitToConsumer,
  publishSearch,
} from "../../lib/command-bar/search.js";
import { useVaultSearch } from "./use-vault-search.js";

/** jsdom lays nothing out: say whether the pane is on screen. */
function Pane({ shown, empty }: { shown: boolean; empty?: boolean }) {
  const pane = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const { query, close } = useVaultSearch(pane, rows);
  const { search } = useLocation();
  return (
    <div
      ref={(node) => {
        pane.current = node;
        if (node) node.getClientRects = () => (shown ? [{}] : []) as never;
      }}
    >
      <div ref={rows} tabIndex={empty ? undefined : 0} hidden={empty}>
        rows
      </div>
      <output data-testid="query">{query ?? "none"}</output>
      <output data-testid="address">{search}</output>
      <button type="button" onClick={close}>
        close
      </button>
    </div>
  );
}

const renderPane = (
  props: { shown: boolean; empty?: boolean },
  at = "/vault",
) =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <Pane {...props} />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  publishSearch(null);
});

describe("the vault list's search", () => {
  it("takes the keyboard when its pane is on screen", () => {
    renderPane({ shown: true });
    expect(commitToConsumer()).toBe("took");
    expect(document.activeElement?.textContent).toBe("rows");
  });

  it("is skipped while a phone has it mounted under the tree", () => {
    renderPane({ shown: false });
    expect(commitToConsumer()).toBe("none");
  });

  it("leaves the caret in the field when an empty list has nothing to land on", () => {
    renderPane({ shown: true, empty: true });
    expect(commitToConsumer()).toBe("seen");
  });

  it("narrows to the words typed in the prompt", () => {
    renderPane({ shown: true });
    act(() => publishSearch("bank"));
    expect(screen.getByTestId("query").textContent).toBe("bank");
  });

  it("seeds from an address q, and the prompt owns the words once there are any", () => {
    renderPane({ shown: true }, "/vault?f=all&q=web");
    expect(screen.getByTestId("query").textContent).toBe("web");
    act(() => publishSearch("git"));
    expect(screen.getByTestId("query").textContent).toBe("git");
    // The stale q is gone from the address, so emptying the prompt cannot
    // fall back to a filter nobody can see.
    expect(screen.getByTestId("address").textContent).toBe("?f=all");
    act(() => publishSearch(null));
    expect(screen.getByTestId("query").textContent).toBe("none");
  });

  it("clears an address q from the tree's Esc", () => {
    renderPane({ shown: true }, "/vault?f=all&q=web");
    act(() => screen.getByRole("button", { name: "close" }).click());
    expect(screen.getByTestId("address").textContent).toBe("?f=all");
  });
});
