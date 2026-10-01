/** @vitest-environment jsdom */
import { mkdirSync, writeFileSync } from "node:fs";
import { ENVIRONMENTS_CAPABILITY } from "@opensesame/app-core/lib/vault/environments.js";
import {
  enableVaultEnvironments,
  resetVaultEnvironments,
} from "@opensesame/app-core/lib/vault/environments.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  profilePlan,
  profileSelection,
} from "../../lib/capabilities/__tests__/vault-profiles.js";
import { EnvironmentsPanel } from "./EnvironmentsPanel.js";

const VAULT = "personal";
const ITEMS = [
  { id: "item-token", key: "API_TOKEN" },
  { id: "item-url", key: "API_URL" },
];

function proof(body: string): void {
  const dir = process.env.ENVIRONMENTS_PROOF;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/environments-ui-component.log`, body);
}

describe("environments panel", () => {
  afterEach(() => {
    cleanup();
    resetVaultEnvironments();
  });

  it("hides the switch and the required control while the capability is off", () => {
    const plan = profilePlan("minimal-local");
    render(<EnvironmentsPanel plan={plan} vaultId={VAULT} items={ITEMS} />);
    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "API_TOKEN required" }),
    ).toBeNull();
    expect(document.getElementById("vault-environments")).toBeNull();
  });

  it("shows the switch and the required control once the vault enables them", () => {
    const plan = profilePlan("minimal-local", {
      installation: {
        ...profileSelection("minimal-local"),
        selectedOptional: [ENVIRONMENTS_CAPABILITY],
      },
    });
    expect(enableVaultEnvironments(plan, VAULT)).toBe(true);
    render(<EnvironmentsPanel plan={plan} vaultId={VAULT} items={ITEMS} />);
    expect(screen.getByRole("combobox", { name: "Environment" })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "API_TOKEN required" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "API_URL required" }),
    ).toBeTruthy();
    proof(
      [
        "disabled=switch absent, required absent",
        "enabled=combobox Environment, checkbox API_TOKEN required, checkbox API_URL required",
      ].join("\n"),
    );
  });
});
