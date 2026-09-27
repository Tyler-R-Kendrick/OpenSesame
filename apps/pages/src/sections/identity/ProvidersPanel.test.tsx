/** @vitest-environment jsdom */
import {
  type IdpRecord,
  listIdpRegistrations,
  registerIdp,
} from "@opensesame/app-core/lib/idp-registry.js";
import {
  IDENTITY_ROUTES,
  IDENTITY_TARGETS,
} from "@opensesame/app-core/tutorial/registry/identity-catalog.js";
import { IDENTITY_GOALS } from "@opensesame/app-core/tutorial/registry/identity-goals.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { declareTutorialForTest } from "../../modules/tutorial-test-realm.js";
import { ProvidersPanel } from "./ProvidersPanel.js";
import { listFederatedProviders, registry } from "./test-seams.js";

function makeRecord(overrides: Partial<IdpRecord>): IdpRecord {
  return {
    id: "byo_1",
    issuer: "https://auth.example.dev",
    label: "Example IdP",
    kind: "byo",
    registeredAt: "2026-08-29T10:00:00Z",
    ...overrides,
  };
}

/** The panel as the section holds it: the list lives in the parent. */
function Harness() {
  const [providers, setProviders] = useState(() => listIdpRegistrations());
  return (
    <ProvidersPanel
      online
      providers={providers}
      onChanged={setProviders}
      onOpenCeremony={() => undefined}
    />
  );
}

let undeclareTutorial: (() => void) | null = null;
beforeEach(async () => {
  // The register key is a guide target; the realm names it, as the
  // federation module's activation does.
  undeclareTutorial = await declareTutorialForTest("identity.federation", {
    targets: IDENTITY_TARGETS,
    goals: IDENTITY_GOALS,
    routes: IDENTITY_ROUTES,
  });
  registry.raw = null;
  listFederatedProviders.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  undeclareTutorial?.();
  listFederatedProviders.mockReset();
});

it("reloads the provider list and the catalog with the head's reload key", async () => {
  render(<Harness />);
  await screen.findByText("OpenSesame (this device)");
  expect(listFederatedProviders).toHaveBeenCalledTimes(1);
  // Registered on another surface: the panel shows it only once reloaded.
  registerIdp(makeRecord({ id: "byo_later", label: "Later IdP" }));
  expect(screen.queryByText("Later IdP")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Reload providers" }),
  );
  expect(await screen.findByText("Later IdP")).toBeTruthy();
  expect(listFederatedProviders).toHaveBeenCalledTimes(2);
});

it("names each provider's kind as text, not a pill, and draws a preset's monogram", async () => {
  registerIdp(
    makeRecord({
      id: "byo_workos",
      issuer: "https://api.workos.com",
      label: "WorkOS",
      providerType: "workos",
    }),
  );
  registerIdp(makeRecord({ id: "byo_legacy", label: "Example IdP" }));
  const { container } = render(<Harness />);
  await screen.findByText("Example IdP");
  expect(container.querySelectorAll(".identity-row .chip")).toHaveLength(0);
  const kinds = Array.from(
    container.querySelectorAll(".identity-row__kind"),
  ).map((kind) => kind.textContent);
  expect(kinds).toEqual(expect.arrayContaining(["WorkOS", "Custom OIDC"]));
  const monograms = Array.from(
    container.querySelectorAll(".identity-row__monogram"),
  ).map((tile) => tile.textContent);
  expect(monograms).toEqual(["W"]);
});

it("arms remove with the operator's note in its label, and keep hands focus back", async () => {
  registerIdp(makeRecord({}));
  render(<Harness />);
  await screen.findByText("Example IdP");
  const remove = screen.getByRole("button", { name: "Remove" });
  await userEvent.click(remove);
  expect(remove.getAttribute("aria-label")).toBe(
    "Remove it from this browser; the operator disables the server registration",
  );
  expect(document.querySelector(".identity-row .hint")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
  expect(document.activeElement).toBe(remove);
  expect(remove.getAttribute("aria-label")).toBe("Remove");
});
