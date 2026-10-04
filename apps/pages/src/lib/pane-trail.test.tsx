/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { type Ascend, usePaneTrail } from "./pane-trail.js";
import { vaultPane } from "./vault-list-path.js";

type Handle = {
  ascend: Ascend;
  go: (to: string | number) => void;
  at: () => string;
  type: () => string;
};

/** Mounts the hook where a phone's vault would, and hands back its controls. */
function mount(entries: string[], index = entries.length - 1): Handle {
  const handle = {} as Handle;
  function Probe() {
    const { pathname, search } = useLocation();
    const navigate = useNavigate();
    const type = useNavigationType();
    const ascend = usePaneTrail(
      vaultPane(pathname, new URLSearchParams(search)),
    );
    handle.ascend = ascend;
    handle.go = (to) => (typeof to === "number" ? navigate(to) : navigate(to));
    handle.at = () => pathname + search;
    handle.type = () => type;
    return null;
  }
  render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Probe />
    </MemoryRouter>,
  );
  return handle;
}

const run = (fn: () => void) => act(async () => fn());

afterEach(cleanup);

describe("usePaneTrail", () => {
  it("climbing to the tree pops the list, so the system Back goes past it", async () => {
    const vault = mount(["/", "/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    expect(vault.type()).toBe("POP");
    await run(() => vault.go(-1));
    expect(vault.at()).toBe("/");
  });

  it("pops past the filter switches between the list and the tree", async () => {
    const vault = mount(["/", "/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault?f=login"));
    await run(() => vault.go("/vault?f=secret"));
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    await run(() => vault.go(-1));
    expect(vault.at()).toBe("/");
  });

  it("climbs from an item to the list it came from, not the one before", async () => {
    const vault = mount(["/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    await run(() => vault.ascend("list", "/vault?f=all"));
    expect(vault.at()).toBe("/vault?f=all");
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
  });

  it("replaces the entry when no earlier entry holds the pane", async () => {
    const vault = mount(["/vault?f=all"]);
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    expect(vault.type()).toBe("REPLACE");
  });

  it("learns an entry it returns to by the system Back button", async () => {
    const vault = mount(["/vault"]);
    await run(() => vault.go("/vault?f=all"));
    await run(() => vault.go("/vault/a?f=all"));
    await run(() => vault.go(-1));
    expect(vault.at()).toBe("/vault?f=all");
    await run(() => vault.ascend("tree", "/vault"));
    expect(vault.at()).toBe("/vault");
    expect(vault.type()).toBe("POP");
  });
});
