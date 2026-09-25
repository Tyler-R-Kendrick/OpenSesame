/** @vitest-environment jsdom */
/**
 * `/i/:ref` and `/approve/:ref` open before unlock (ADR 0140 §2, D7): with
 * no vault on the device, or a locked one, the app draws the ceremony the
 * module contributes on its own page — never the unlock screen, never the
 * shell — and nothing in it reads the vault.
 */
import { resetApprovalArrivalForTests } from "@opensesame/app-core/lib/approvals-link.js";
import type { RouteContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { resetInteractionArrivalForTests } from "@opensesame/app-core/lib/interactions-link.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App, type AppSlots } from "../../App.js";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { createTestContext } from "../test-context.js";
import { REF } from "./ceremony-server.test-support.js";
import { capabilityRuntime } from "./runtime.js";

Object.assign(identityHookSeams, {
  useConnect: () => ({ connect: vi.fn(), connecting: false, error: null }),
  useIdentitySession: () => null,
});
Object.assign(useOnlineSeams, { useOnline: () => true });

let routes: RouteContribution[] = [];
const vault = { status: "empty" };

beforeAll(async () => {
  const t = createTestContext();
  await capabilityRuntime.activate(t.ctx);
  routes = t.entries("route");
});

afterEach(() => {
  cleanup();
  resetInteractionArrivalForTests();
  resetApprovalArrivalForTests();
  history.replaceState(null, "", "/");
});

const slots: Partial<AppSlots> = {
  hasAuthResponse: () => false,
  useVault: () => ({ status: vault.status, tomb: "personal", guest: false }),
  useTheme: () => {},
  useSessionGuards: () => {},
  useRouteContributions: () => routes,
  useUnlockEffects: () => [],
  useShellWrappers: () => [],
  recoverPendingFederatedLink: () => {},
  AppShell: ({ children }) => <div data-testid="app-shell">{children}</div>,
  FederationReturn: () => <p>federation return stub</p>,
  UnlockScreen: () => <p>unlock screen stub</p>,
};

function open(path: string) {
  history.replaceState(null, "", path);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App slots={slots} />
    </MemoryRouter>,
  );
}

describe("approval ceremonies with no vault", () => {
  for (const status of ["empty", "locked"]) {
    it(`draws /i/:ref on its own page on a ${status} device`, async () => {
      vault.status = status;
      open(`/i/${REF}`);
      expect(
        await screen.findByRole("heading", { name: "Approve a request" }),
      ).toBeTruthy();
      expect(screen.queryByText("unlock screen stub")).toBeNull();
      expect(screen.queryByTestId("app-shell")).toBeNull();
      expect(screen.getByRole("main")).toBeTruthy();
    });

    it(`draws /approve/:ref on its own page on a ${status} device`, async () => {
      vault.status = status;
      open("/approve/areq_abc");
      expect(
        await screen.findByRole("heading", { name: "Review a request" }),
      ).toBeTruthy();
      expect(screen.queryByText("unlock screen stub")).toBeNull();
      expect(screen.queryByTestId("app-shell")).toBeNull();
    });
  }

  it("keeps the front door in front of every other path", () => {
    vault.status = "empty";
    open("/access");
    expect(screen.getByText("unlock screen stub")).toBeTruthy();
  });
});
