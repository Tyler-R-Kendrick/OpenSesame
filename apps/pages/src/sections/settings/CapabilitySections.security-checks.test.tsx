/** @vitest-environment jsdom */
import { SECURITY_CHECKS_SUMMARY } from "@opensesame/app-core/lib/capabilities/catalog-optional-vault.js";
import { SECURITY_CHECKS_IDLE } from "@opensesame/app-core/lib/vault/security-checks.js";
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { clearSecurityWatch } from "@opensesame/app-core/lib/vault/security-checks.js";
import { MAX_SUMMARY_LENGTH } from "@opensesame/capability-composition";
import {
  type AccountItem,
  createItem,
  manualPassword,
  newUri,
} from "@opensesame/vault-core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { securityChecksPanel } from "../../modules/vault.security-checks/SecurityChecksPanel.js";
import { sectionCategory } from "./CapabilitySections.js";
import {
  installPanelFixture,
  renderPanel,
} from "./capabilities-panel.test-support.js";

installDoublePorts();
installPanelFixture();

/** SHA-1 of "password": 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8. */
const RANGE = "1E4C9B93F3F0682250B6CF8331B7EE68FD8:42\r\n0000:0";
const LIST = [["GitHub", { domain: "github.com", tfa: ["totp"] }]];

function login(name: string, password: string, uri: string): AccountItem {
  const base = createItem("account", name);
  if (base.kind !== "account") throw new Error("not an account");
  return {
    ...base,
    uris: [newUri(uri)],
    methods: [manualPassword(`${base.id}:password`, password, base.createdAt)],
  };
}

const ITEMS = [
  login("GitHub", "password", "https://github.com"),
  login("Shop", "a-long-unique-passphrase", "https://shop.example"),
];

let revoke: (() => void) | null = null;

afterEach(() => {
  revoke?.();
  revoke = null;
  clearSecurityWatch();
});

describe("Breach and two-step checks in Settings", () => {
  it("explains the capability while its switch is off", () => {
    expect(SECURITY_CHECKS_SUMMARY.length).toBeLessThanOrEqual(
      MAX_SUMMARY_LENGTH,
    );
    const { container } = renderPanel();
    const section = container.querySelector("#feature-security-checks");
    expect(section?.textContent).toContain(SECURITY_CHECKS_SUMMARY);
    expect(section?.textContent).toContain("Password health");
    expect(section?.textContent).toContain("Press Check");
    expect(
      screen.queryByRole("button", {
        name: "Check logins against breaches and two-step sites",
      }),
    ).toBeNull();
  });

  it("shows breach and two-step outcomes in the section when the capability is on", async () => {
    const current = vaultHooksSeams.useVault;
    vaultHooksSeams.useVault = () => ({
      ...current(),
      status: "unlocked",
      items: ITEMS,
    });
    // What activate() registers: the check panel inside this section.
    revoke = registerContributionForTest("settings-panel", {
      id: "capability-security-checks",
      label: "Breach and two-step checks",
      category: sectionCategory("feature-security-checks"),
      Panel: securityChecksPanel({
        range: async () => new Response(RANGE),
        twoFactor: async () => Response.json(LIST),
      }),
      order: 10,
    });
    const { container } = renderPanel();
    const section = container.querySelector("#feature-security-checks");
    expect(section?.textContent).toContain(SECURITY_CHECKS_SUMMARY);
    expect(section?.textContent).toContain(SECURITY_CHECKS_IDLE);
    expect(screen.getAllByText(SECURITY_CHECKS_SUMMARY)).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Check logins against breaches and two-step sites",
      }),
    );
    await waitFor(() =>
      expect(section?.textContent).toContain(
        "1 of 2 passwords found in known breaches. 1 login could add an authenticator code.",
      ),
    );
    expect(section?.textContent).toContain(
      "Found in breaches 42 times: change this password",
    );
    expect(section?.textContent).toContain(
      "This site takes an authenticator code; none is stored",
    );
    expect(section?.textContent).not.toContain("Shop");
  });
});
