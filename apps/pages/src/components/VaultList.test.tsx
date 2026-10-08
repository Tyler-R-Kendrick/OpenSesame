import type { DeviceVault } from "@opensesame/app-core/lib/vaults.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultList, describeVaultRow } from "./VaultList.js";

const personal: DeviceVault = {
  id: "personal",
  kind: "personal",
  label: "personal",
  named: true,
  sealedAt: "2026-08-14T10:00:00Z",
  state: "open",
  sharedKey: false,
};

const work: DeviceVault = {
  id: "prj_work",
  kind: "project",
  label: "Work",
  named: true,
  sealedAt: "2026-08-27T10:00:00Z",
  state: "locked",
  sharedKey: true,
};

const unnamed: DeviceVault = {
  id: "prj_9c11",
  kind: "project",
  label: "project · 9c11",
  named: false,
  sealedAt: "2026-08-31T10:00:00Z",
  state: "locked",
  sharedKey: false,
};

const guest: DeviceVault = {
  id: "guest",
  kind: "guest",
  label: "guest",
  named: true,
  sealedAt: null,
  state: "empty",
  sharedKey: false,
};

afterEach(cleanup);

describe("describeVaultRow — one line of truth", () => {
  it("says how a vault opens before the person presses it", () => {
    expect(describeVaultRow(work)).toMatch(/opens without a prompt$/);
    expect(describeVaultRow(unnamed)).toMatch(/name is inside the vault$/);
    expect(
      describeVaultRow({ ...unnamed, sealedAt: null, state: "empty" }),
    ).toBe("not sealed yet");
    expect(describeVaultRow(guest)).toBe(
      "no key · this tab only · nothing here is touched",
    );
  });
});

describe("VaultList", () => {
  it("renders the open vault as the current row, not a control", () => {
    render(<VaultList vaults={[personal, work]} onPick={vi.fn()} />);
    const open = document.querySelector(".vault-row--open [aria-current]");
    expect(open?.textContent).toContain("personal");
    expect(open?.querySelector('[aria-label="Open"]')).toBeTruthy();
    expect(open?.tagName).toBe("DIV");
    expect(screen.getByRole("button", { name: /Work/ })).toBeTruthy();
  });

  it("pressing a row is the switch", () => {
    const onPick = vi.fn();
    render(<VaultList vaults={[work, guest]} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /guest/ }));
    expect(onPick).toHaveBeenCalledWith(guest);
  });

  it("shows the state chip and the trailing control", () => {
    render(
      <VaultList
        vaults={[unnamed]}
        onPick={vi.fn()}
        trailing={(vault) => <span data-testid={`trail-${vault.id}`} />}
      />,
    );
    expect(screen.getByLabelText("Locked")).toBeTruthy();
    expect(screen.getByTestId("trail-prj_9c11")).toBeTruthy();
  });

  it("disables every row while a switch is in flight", () => {
    render(<VaultList vaults={[work, guest]} disabled onPick={vi.fn()} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });
});

describe("VaultList — a face for each vault", () => {
  it("draws every row's glyph from its own id, so no two rows share one", () => {
    render(
      <VaultList vaults={[personal, work, unnamed, guest]} onPick={() => {}} />,
    );
    const faces = [...document.querySelectorAll(".vault-row")].map((row) =>
      row.querySelector(".vault-row__mark .glyph__on")?.getAttribute("d"),
    );
    expect(faces).toHaveLength(4);
    expect(faces.every(Boolean)).toBe(true);
    expect(new Set(faces).size).toBe(4);
  });

  it("keeps the name beside the glyph, so a face is always introduced", () => {
    render(<VaultList vaults={[work]} onPick={() => {}} />);
    const row = document.querySelector(".vault-row__body");
    expect(row?.querySelector(".glyph")).not.toBeNull();
    expect(row?.querySelector(".vault-row__name")?.textContent).toBe("Work");
  });

  it("shows each vault's name in the menu the picker opens, including the open one", () => {
    render(
      <VaultList vaults={[personal, work]} density="menu" onPick={() => {}} />,
    );
    const names = [
      ...document.querySelectorAll(".vault-list--menu .vault-row__name"),
    ].map((node) => node.textContent);
    expect(names).toEqual(["personal", "Work"]);
    expect(
      document.querySelector(
        ".vault-list--menu .vault-row--open .vault-row__name",
      )?.textContent,
    ).toBe("personal");
    expect(screen.getByRole("button", { name: /Work/ })).toBeTruthy();
  });
});
