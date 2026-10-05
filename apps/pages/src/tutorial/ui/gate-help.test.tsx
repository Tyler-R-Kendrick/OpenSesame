/** @vitest-environment jsdom */

/**
 * What the help key on the screens in front of the shell opens (ADR 0165): the
 * same Support sheet, offline, listing the tutorials written for the screen.
 */

import type { ShellWrapperContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GateHelpSeat, GateHost } from "../gate-seat.js";
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
function Screen({
  route,
  seat = true,
  children,
}: {
  route: string;
  seat?: boolean;
  children?: ReactNode;
}) {
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
  screenProps: { route: string; seat?: boolean },
) {
  return render(
    <MemoryRouter>
      <GateHost wrappers={wrappers}>
        <Screen {...screenProps} />
      </GateHost>
    </MemoryRouter>,
  );
}

describe("what the key opens", () => {
  async function open(route: string) {
    const user = userEvent.setup();
    renderGate([support], { route });
    await user.click(screen.getByRole("button", { name: "Support" }));
    const sheet = await screen.findByRole("dialog", { name: "Support" });
    return { user, sheet };
  }

  it("is the Support sheet, with the written help to search and no model to ask", async () => {
    const { sheet } = await open("/unlock/door");
    expect(
      await within(sheet).findByLabelText("Search the written help"),
    ).toBeTruthy();
    expect(
      within(sheet).queryByRole("button", { name: /download/i }),
    ).toBeNull();
  });

  it("lists the tutorials written for this gate and none of the shell's", async () => {
    const { user, sheet } = await open("/unlock/door");
    await user.click(within(sheet).getByRole("tab", { name: "Tutorials" }));
    const rows = sheet.querySelectorAll("[data-tutorial]");
    expect([...rows].map((row) => row.getAttribute("data-tutorial"))).toEqual([
      "gate.front-door",
      "gate.join",
    ]);
  });

  it("lists the typed-key tutorials on the unlock form, and not the door's", async () => {
    const { user, sheet } = await open("/unlock/form");
    await user.click(within(sheet).getByRole("tab", { name: "Tutorials" }));
    const ids = [...sheet.querySelectorAll("[data-tutorial]")].map((row) =>
      row.getAttribute("data-tutorial"),
    );
    expect(ids).toContain("gate.unlock");
    expect(ids).not.toContain("gate.front-door");
    expect(ids).not.toContain("gate.unlock.passkey");
  });

  it("asks the shell's questions nowhere: the Ask tab is the gate's own", async () => {
    const { sheet } = await open("/unlock/door");
    const questions = await within(sheet).findByRole("region", {
      name: "Questions",
    });
    const titles = within(questions)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
    expect(titles).not.toContain("Where do I lock the vault?");
    expect(titles).toContain("The front door: two roads and Skip");
  });

  it("offers a Show me for written help only where its screen can start the tour", async () => {
    const form = await open("/unlock/form");
    const unlock = await within(form.sheet).findByText(
      "How do I unlock the vault?",
    );
    expect(
      within(unlock.closest("article") as HTMLElement).queryByRole("button", {
        name: "Show me",
      }),
    ).not.toBeNull();
    cleanup();
    const door = await open("/unlock/door");
    const written = await within(door.sheet).findByText(
      "How do I unlock the vault?",
    );
    expect(
      within(written.closest("article") as HTMLElement).queryByRole("button", {
        name: "Show me",
      }),
    ).toBeNull();
  });
});
