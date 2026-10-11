/** @vitest-environment jsdom */
/**
 * The vault's Environments key: addressed by the vault's own URL so a notice
 * can open it, Back closes it, and a phone reaches the same flow through the
 * Add button's menu.
 */

import { ENVIRONMENTS_PATH } from "@opensesame/app-core/lib/vault/environments.js";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { addEntries } from "../../sections/vault/add-menu.js";
import { EnvironmentsEntry, EnvironmentsKey } from "./EnvironmentsKey.js";
import {
  APPROVED_PLAN,
  closeVault,
  openVaultWith,
} from "./environments.test-support.js";
import { environmentSeams } from "./use-environments.js";

const seams = { ...environmentSeams };

beforeAll(() => {
  environmentSeams.usePlan = () => APPROVED_PLAN;
});

afterAll(() => {
  Object.assign(environmentSeams, seams);
});

function Where() {
  const { pathname, search } = useLocation();
  return <output aria-label="address">{`${pathname}${search}`}</output>;
}

function shown(at: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      {element}
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await openVaultWith("Stripe key");
});

afterEach(async () => {
  cleanup();
  await closeVault();
});

const address = () => screen.getByLabelText("address").textContent;

describe("the Environments key", () => {
  it("is an icon key with a name, closed until it is pressed", () => {
    shown("/vault", <EnvironmentsKey />);
    const key = screen.getByRole("button", { name: "Environments" });
    expect(key.getAttribute("aria-haspopup")).toBe("dialog");
    expect(key.getAttribute("aria-expanded")).toBe("false");
    expect(key.textContent).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the sheet at the vault's own address and closes it by removing it", async () => {
    const user = userEvent.setup();
    shown("/vault?f=secret", <EnvironmentsKey />);
    await user.click(screen.getByRole("button", { name: "Environments" }));
    expect(screen.getByRole("dialog", { name: "Environments" })).toBeTruthy();
    expect(address()).toBe("/vault?f=secret&environments=1");
    expect(
      screen
        .getByRole("button", { name: "Environments" })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    // The sheet's own close key is the last one in the document.
    const close = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Close",
    });
    await user.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(address()).toBe("/vault?f=secret");
  });

  it("closes with Escape, and leaves the filter alone", async () => {
    const user = userEvent.setup();
    shown("/vault?f=secret", <EnvironmentsKey />);
    await user.click(screen.getByRole("button", { name: "Environments" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(address()).toBe("/vault?f=secret");
  });

  it("is open on arrival when a notice sent the person to its address", () => {
    shown(ENVIRONMENTS_PATH, <EnvironmentsKey />);
    expect(screen.getByRole("dialog", { name: "Environments" })).toBeTruthy();
  });
});

describe("the Environments entry on a phone", () => {
  it("is one of the Add button's other ways to add, after Import and before Export", () => {
    shown("/vault", <EnvironmentsEntry />);
    const entry = addEntries().find(
      (candidate) => candidate.id === "environments",
    );
    expect(entry).toMatchObject({ label: "Environments", order: 20 });
    expect(entry?.slide).toBeUndefined();
  });

  it("opens the same sheet when chosen, and leaves the menu when it unmounts", async () => {
    const { unmount } = shown("/vault", <EnvironmentsEntry />);
    const entry = addEntries().find(
      (candidate) => candidate.id === "environments",
    );
    await act(async () => entry?.run());
    expect(screen.getByRole("dialog", { name: "Environments" })).toBeTruthy();
    expect(address()).toBe("/vault?environments=1");
    unmount();
    expect(
      addEntries().some((candidate) => candidate.id === "environments"),
    ).toBe(false);
  });
});
