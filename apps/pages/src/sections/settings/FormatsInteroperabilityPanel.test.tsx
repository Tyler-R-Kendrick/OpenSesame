/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { FormatsInteroperabilityPanel } from "./FormatsInteroperabilityPanel.js";

const original = { ...vaultHooksSeams };

type ViewState = { guest: boolean; status: string };

function vault(state: ViewState) {
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ header: null, ...state }),
    useVaultStore: () => ({ getSnapshot: () => ({ header: null }) }),
  });
}

beforeEach(() => vault({ guest: true, status: "unlocked" }));
afterEach(() => {
  cleanup();
  Object.assign(vaultHooksSeams, original);
});

function keys(container: HTMLElement) {
  return [...container.querySelectorAll("button")].map((button) =>
    button.getAttribute("aria-label"),
  );
}

describe("FormatsInteroperabilityPanel", () => {
  it("is a list of things to do, not a table of what is supported", () => {
    const { container } = render(<FormatsInteroperabilityPanel />);
    expect(screen.getByRole("heading", { name: "Formats" })).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByText("GPG")).toBeNull();
  });

  it("a guest is offered only what needs no vault — nothing disabled", () => {
    const { container } = render(<FormatsInteroperabilityPanel />);
    expect(keys(container)).toEqual(["SOPS document", "age armor"]);
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(false);
    }
  });

  it("an open vault is also offered its manifest and its SOPS export", () => {
    vault({ guest: false, status: "unlocked" });
    const { container } = render(<FormatsInteroperabilityPanel />);
    expect(keys(container)).toEqual([
      "Export native protection manifest",
      "SOPS document",
      "Vault SOPS",
      "age armor",
    ]);
  });
});
