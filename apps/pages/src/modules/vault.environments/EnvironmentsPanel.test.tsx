/** @vitest-environment jsdom */
import { mkdirSync, writeFileSync } from "node:fs";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  ENVIRONMENTS_CAPABILITY,
  enableVaultEnvironments,
  markEnvironmentRequired,
  notifyMissingEnvironmentValues,
  renderEnvSchema,
  resetVaultEnvironments,
  switchEnvironment,
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
    clearNotices();
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
    expect(renderEnvSchema(plan, VAULT, ITEMS)).toBe(
      "# @type=string\nAPI_TOKEN=\n\n# @type=string\nAPI_URL=",
    );
    proof(
      [
        "disabled=switch absent, required absent",
        "enabled=combobox Environment, checkbox API_TOKEN required, checkbox API_URL required",
      ].join("\n"),
    );
  });

  it("clears the missing-value notice when the capability is turned off", () => {
    const approved = profilePlan("minimal-local", {
      installation: {
        ...profileSelection("minimal-local"),
        selectedOptional: [ENVIRONMENTS_CAPABILITY],
      },
    });
    const view = render(
      <EnvironmentsPanel plan={approved} vaultId={VAULT} items={ITEMS} />,
    );
    expect(switchEnvironment(approved, VAULT, "production").ok).toBe(true);
    expect(
      markEnvironmentRequired(approved, VAULT, "production", ITEMS[0].id, true)
        .ok,
    ).toBe(true);
    notifyMissingEnvironmentValues(approved, VAULT, ITEMS);
    expect(listNotices().map((notice) => notice.id)).toContain(
      "vault.environments.missing",
    );
    view.rerender(
      <EnvironmentsPanel
        plan={profilePlan("minimal-local")}
        vaultId={VAULT}
        items={ITEMS}
      />,
    );
    expect(listNotices().map((notice) => notice.id)).not.toContain(
      "vault.environments.missing",
    );
    expect(
      renderEnvSchema(profilePlan("minimal-local"), VAULT, ITEMS),
    ).toBeNull();
  });
});
