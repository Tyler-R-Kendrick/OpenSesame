/** @vitest-environment jsdom */

/**
 * The seat the help key sits in on the screens in front of the shell (ADR
 * 0165): where it is drawn, and that it never costs a screen its state.
 */

import type { ShellWrapperContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect } from "react";
import { MemoryRouter } from "react-router";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GateHelpSeat, GateHost, useGateRoute } from "../gate-seat.js";
import { supportSessionSeams, useSupportRoute } from "../session.js";
import { SupportGate, supportGateSeams } from "./SupportGate.js";
import { buildEngine } from "./support-test-engine.js";

const original = { ...supportSessionSeams };
const originalGate = { ...supportGateSeams };
let revokeRealm = () => {};

beforeAll(async () => {
  await import("./SupportPanel.js");
});

beforeEach(() => {
  revokeRealm = registerTutorialRealm();
  Object.assign(supportSessionSeams, {
    onLock: () => () => {},
    clearTargets: () => {},
  });
  supportGateSeams.loadEngine = () =>
    Promise.resolve(buildEngine(fakeAgentAlwaysUnavailable("no_local_model")));
});

afterEach(() => {
  cleanup();
  revokeRealm();
  Object.assign(supportSessionSeams, original);
  Object.assign(supportGateSeams, originalGate);
});

const support: ShellWrapperContribution = {
  id: "support",
  order: 10,
  Wrapper: ({ children }) => <>{children}</>,
  Gate: SupportGate,
};

/** A gate screen: declares where it is, and draws its seat in its chrome row. */
type GateScreenProps = { route: string; seat?: boolean };

function Screen({
  route,
  seat = true,
  children,
}: GateScreenProps & { children?: ReactNode }) {
  useSupportRoute(route);
  return (
    <div data-testid="screen">
      <header data-testid="chrome">{seat ? <GateHelpSeat /> : null}</header>
      <button type="button">a road</button>
      {children}
    </div>
  );
}

function renderGate(
  wrappers: readonly ShellWrapperContribution[],
  screenProps: GateScreenProps,
) {
  return render(
    <MemoryRouter>
      <GateHost wrappers={wrappers}>
        <Screen {...screenProps} />
      </GateHost>
    </MemoryRouter>,
  );
}

describe("where the key sits", () => {
  it("draws one icon key in the seat the screen drew, named and titled", () => {
    renderGate([support], { route: "/unlock/door" });
    const key = screen.getByRole("button", { name: "Support" });
    expect(screen.getAllByRole("button", { name: "Support" })).toHaveLength(1);
    expect(
      within(screen.getByTestId("chrome")).getByRole("button", {
        name: "Support",
      }),
    ).toBe(key);
    expect(key.closest(".gate-seat")).not.toBeNull();
    expect(key.getAttribute("title")).toBe("Support");
    expect(key.className).toContain("icon-btn");
    // An icon and no painted verb (docs/design/controls.md).
    expect(key.textContent).toBe("");
  });

  it("is not drawn, and does not float, where the screen drew no seat", () => {
    renderGate([support], { route: "/unlock/door", seat: false });
    expect(screen.queryByRole("button", { name: "Support" })).toBeNull();
  });

  it("is not drawn when no capability contributed a gate", () => {
    renderGate([], { route: "/unlock/door" });
    expect(screen.queryByRole("button", { name: "Support" })).toBeNull();
    expect(
      screen.getByTestId("chrome").querySelector(".gate-seat"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "a road" })).toBeTruthy();
  });

  it("never takes the focus", () => {
    renderGate([support], { route: "/unlock/door" });
    expect(document.activeElement).toBe(document.body);
  });

  it("is a key a Tab reaches", async () => {
    const user = userEvent.setup();
    renderGate([support], { route: "/unlock/door" });
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Support" }),
    );
  });
});

describe("the screen is never remounted", () => {
  it("keeps the screen's state while a capability arrives and leaves", () => {
    const mounts = vi.fn();
    function Counting() {
      useEffect(() => {
        mounts();
      }, []);
      return <button type="button">typed into</button>;
    }
    const tree = (wrappers: readonly ShellWrapperContribution[]) => (
      <MemoryRouter>
        <GateHost wrappers={wrappers}>
          <Counting />
        </GateHost>
      </MemoryRouter>
    );
    const { rerender } = render(tree([]));
    rerender(tree([support]));
    rerender(tree([]));
    rerender(tree([support]));
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it("draws the capability beside the screen, not around it", () => {
    function Probe() {
      return <output data-testid="gate">gate</output>;
    }
    const beside: ShellWrapperContribution = {
      id: "probe",
      order: 1,
      Wrapper: ({ children }) => <>{children}</>,
      Gate: Probe,
    };
    renderGate([beside], { route: "/unlock/door" });
    expect(
      screen.getByTestId("gate").contains(screen.getByTestId("screen")),
    ).toBe(false);
    expect(
      screen.getByTestId("screen").contains(screen.getByTestId("gate")),
    ).toBe(false);
  });
});

describe("the route the screen declares", () => {
  it("reaches the gate side, and is forgotten when the screen goes", () => {
    function Reads() {
      return <output data-testid="route">{useGateRoute() ?? "none"}</output>;
    }
    const reader: ShellWrapperContribution = {
      id: "reader",
      order: 1,
      Wrapper: ({ children }) => <>{children}</>,
      Gate: Reads,
    };
    const { unmount } = renderGate([reader], { route: "/setup/identity" });
    expect(screen.getByTestId("route").textContent).toBe("/setup/identity");
    unmount();
  });
});
