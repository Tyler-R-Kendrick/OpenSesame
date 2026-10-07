/** @vitest-environment jsdom */
/// <reference path="../../../../packages/control-plane/src/nodemailer-shim.d.ts" />
import { configureHost, host } from "@opensesame/app-core/host.js";
import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import { listOAuthClients } from "@opensesame/app-core/lib/directory.js";
import { writeSignInService } from "@opensesame/app-core/lib/identity-service.js";
import { adoptToken, clearSession } from "@opensesame/app-core/lib/identity.js";
import { IDENTITY_VIEWS } from "@opensesame/app-core/lib/section-view-names.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { clearVaultSurface } from "@opensesame/app-core/lib/vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import {
  IDENTITY_ROUTES,
  IDENTITY_TARGETS,
} from "@opensesame/app-core/tutorial/registry/identity-catalog.js";
import { IDENTITY_GOALS } from "@opensesame/app-core/tutorial/registry/identity-goals.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { verifiedPrincipal } from "../../../../packages/control-plane/src/__tests__/authentication-fixture.js";
import { createControlPlane } from "../../../../packages/control-plane/src/create-app.js";
import { expectInTray } from "../components/tray.test-support.js";
import { declareTutorialForTest } from "../modules/tutorial-test-realm.js";
import { IdentitySection } from "./IdentitySection.js";
import { contributeIdentityForTests } from "./identity/identity-test-support.js";

function applicationRow(id: string): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLLIElement>("li.identity-row")];
  const row = rows.find((candidate) => candidate.textContent?.includes(id));
  if (!row) throw new Error("Missing real application row");
  return row;
}

it("registers, rotates and revokes a genuine owner's application through the authored Identity UI and real HTTP routes", async () => {
  const originalHost = host();
  const settings = loadSettings();
  const base = "https://localhost:5189";
  const password = "identity-lifecycle-real-vault-owner";
  const cp = createControlPlane({
    processEnv: { NODE_ENV: "test", OPENSESAME_ALLOW_DEV_DEFAULTS: "1" },
    config: { port: 0, publicUrl: base, issuer: base },
  });
  const requests: string[] = [];
  let ownerCreated = false;
  let revokeViews = () => {};
  let revokeTutorial = () => {};
  const originalFetch = globalThis.fetch;
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      securityProfile: {
        version: 1,
        profile: "loopback_development",
        canonicalOrigin: window.location.origin,
        headerSecurity: false,
      },
    }),
  );
  try {
    await cp.ctx.systemPrincipalReady;
    const owner = await verifiedPrincipal(cp.app);
    await clearVaultSurface();
    vaultStore.loadActiveProjectScope();
    await vaultStore.create(password);
    ownerCreated = true;
    writeSignInService(base);
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== base)
        throw new Error("Unexpected physical destination");
      requests.push(`${request.method} ${url.pathname}`);
      return cp.app.request(request);
    };
    await adoptToken(owner.auth.authorization.slice("Bearer ".length));
    revokeViews = contributeIdentityForTests(IDENTITY_VIEWS);
    revokeTutorial = await declareTutorialForTest("identity.federation", {
      targets: IDENTITY_TARGETS,
      goals: IDENTITY_GOALS,
      routes: IDENTITY_ROUTES,
    });
    render(
      <MemoryRouter initialEntries={["/identity?view=service-accounts"]}>
        <IdentitySection />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Register an application" });
    const beforeInvalid = requests.length;
    fireEvent.click(screen.getByRole("button", { name: "Register client" }));
    await expectInTray(
      "A display name, at least one redirect URI, and a sector identifier are all required.",
    );
    expect(
      requests.slice(beforeInvalid).some((value) => value.startsWith("POST ")),
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Actual release owner" },
    });
    fireEvent.change(screen.getByLabelText("Redirect URIs — one per line"), {
      target: { value: "https://release.example.test/callback" },
    });
    fireEvent.change(screen.getByLabelText("Sector identifier"), {
      target: { value: "https://release.example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register client" }));
    await screen.findByRole("heading", { name: "Actual release owner" });
    const first = (await listOAuthClients()).find(
      (row) =>
        row.displayName === "Actual release owner" && row.state === "active",
    );
    if (!first) throw new Error("Missing server-created client");
    fireEvent.click(
      within(applicationRow(first.id)).getByRole("button", {
        name: "Rotate client ID",
      }),
    );
    await waitFor(async () => {
      expect(
        (await listOAuthClients()).find((row) => row.id === first.id),
      ).toBeUndefined();
      expect((await cp.ctx.stores.oauthClients.findById(first.id))?.state).toBe(
        "revoked",
      );
    });
    const next = (await listOAuthClients()).find(
      (row) => row.displayName === first.displayName && row.state === "active",
    );
    if (!next) throw new Error("Missing real rotated client");
    expect(next.id).not.toBe(first.id);
    await waitFor(() => expect(applicationRow(next.id)).toBeTruthy());
    fireEvent.click(
      within(applicationRow(next.id)).getByRole("button", { name: "Revoke" }),
    );
    fireEvent.click(
      within(applicationRow(next.id)).getByRole("button", { name: "Keep it" }),
    );
    expect(
      (await listOAuthClients()).find((row) => row.id === next.id)?.state,
    ).toBe("active");
    fireEvent.click(
      within(applicationRow(next.id)).getByRole("button", { name: "Revoke" }),
    );
    fireEvent.click(
      within(applicationRow(next.id)).getByRole("button", {
        name: "Revoke it",
      }),
    );
    await waitFor(async () => {
      expect(
        (await listOAuthClients()).find((row) => row.id === next.id),
      ).toBeUndefined();
      expect((await cp.ctx.stores.oauthClients.findById(next.id))?.state).toBe(
        "revoked",
      );
    });
  } finally {
    cleanup();
    try {
      if (ownerCreated) {
        vaultStore.lock();
        vaultStore.loadActiveProjectScope();
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      clearSession();
      globalThis.fetch = originalFetch;
      saveSettings(settings);
      revokeTutorial();
      revokeViews();
      configureHost(originalHost);
      vi.restoreAllMocks();
    }
  }
});
