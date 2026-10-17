/** @vitest-environment jsdom */
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  double,
  installDoublePorts,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  FIXTURE_DISTRIBUTION,
  fixtureResolveInput,
  resolveComposition,
} from "@opensesame/capability-composition";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSONAL_SELECTION,
  withReceipt,
} from "../settings/settings-panels.test-support.js";
import { PasswordsOnboarding } from "./PasswordsOnboarding.js";
import { addEntries } from "./add-menu.js";
import {
  commitPasswordsOnboarding,
  passwordsOnboardingSeams,
  passwordsProposal,
} from "./passwords-onboarding.js";

installDoublePorts();

const originalCommitProposal = passwordsOnboardingSeams.commitProposal;
const originalEnablePack = passwordsOnboardingSeams.enablePack;

beforeEach(() => {
  vi.stubEnv("VITE_PWA_OFFER_PASSWORDS_ONBOARDING", "1");
  resetDouble({ selection: PERSONAL_SELECTION, receipt: withReceipt() });
  passwordsOnboardingSeams.enablePack = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  passwordsOnboardingSeams.commitProposal = originalCommitProposal;
  passwordsOnboardingSeams.enablePack = originalEnablePack;
});

function productionSnapshot() {
  capabilityPorts.CAPABILITY_CATALOG = CAPABILITY_CATALOG;
  const plan = resolveComposition(
    fixtureResolveInput({
      catalog: CAPABILITY_CATALOG,
      distribution: {
        ...FIXTURE_DISTRIBUTION,
        capabilityIds: CAPABILITY_CATALOG.capabilities.map((entry) => entry.id),
        moduleIds: CAPABILITY_CATALOG.capabilities.flatMap(
          (entry) => entry.moduleIds,
        ),
      },
      installation: PERSONAL_SELECTION,
      installationId: PERSONAL_SELECTION.installationId,
    }),
  );
  return { ...double.getSnapshot(), plan };
}

describe("the fresh-vault Passwords offer", () => {
  it("commits only derived records, then enables the account pack", async () => {
    const snapshot = productionSnapshot();
    const proposal = passwordsProposal(snapshot);
    expect(new Set(proposal.roots)).toEqual(
      new Set([
        "agents.webmcp",
        "vault.passkey-records",
        "vault.derived-records",
      ]),
    );
    expect(proposal.roots).not.toContain("identity.siop");
    expect(proposal.roots).not.toContain("identity.ambient-sso");
    const commit = vi.fn(async () => null);
    passwordsOnboardingSeams.commitProposal = commit;

    expect(await commitPasswordsOnboarding(snapshot)).toBeNull();

    expect(commit).toHaveBeenCalledWith(snapshot, proposal);
    expect(passwordsOnboardingSeams.enablePack).toHaveBeenCalledWith("account");
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(passwordsOnboardingSeams.enablePack).mock
        .invocationCallOrder[0] ?? 0,
    );
  });

  it("is absent when the build flag is off", () => {
    vi.stubEnv("VITE_PWA_OFFER_PASSWORDS_ONBOARDING", "0");
    render(<PasswordsOnboarding placement="path" />);
    expect(screen.queryByRole("button", { name: "Passwords" })).toBeNull();
    expect(double.commits).toEqual([]);
  });

  it("offers Passwords as a path-strip key, not a buffer row", () => {
    const { container } = render(<PasswordsOnboarding placement="path" />);
    const button = screen.getByRole("button", { name: "Passwords" });
    expect(button.classList.contains("icon-btn")).toBe(true);
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".buffer__line")).toBeNull();
  });

  it("registers Passwords beside the existing Add menu flows", () => {
    const view = render(<PasswordsOnboarding placement="add-menu" />);
    expect(addEntries().map((entry) => entry.id)).toContain(
      "passwords-onboarding",
    );
    expect(
      addEntries().find((entry) => entry.id === "passwords-onboarding")?.label,
    ).toBe("Passwords");
    view.unmount();
    expect(addEntries().map((entry) => entry.id)).not.toContain(
      "passwords-onboarding",
    );
  });
});
