/** @vitest-environment jsdom */
/**
 * `/invoke/:kind` opens before unlock (ADR 0140 §2, plan step 10): on an
 * empty or locked device the hand-off draws on its own page, its key opens
 * the app link ceremony-kit built and holds the focus, an MFA user code falls
 * back to `/device` through the device link's own hand-off, a wallet request
 * is never fetched, and a kind the spec does not list is refused in
 * ceremony-kit's words, on a mark and in the tray.
 */
import type { RouteContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  peekDeviceArrival,
  resetDeviceArrivalForTests,
} from "@opensesame/app-core/lib/device-link.js";
import {
  captureInvocationArrivalFromPage,
  resetInvocationArrivalForTests,
} from "@opensesame/app-core/lib/invoke-link.js";
import { INVOCATION_NOTICE } from "@opensesame/app-core/lib/invoke-route.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App, type AppSlots } from "../../App.js";
import { identityHookSeams } from "../../bindings/identity.js";
import { useOnlineSeams } from "../../lib/use-online.js";
import { createTestContext } from "../test-context.js";
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
  resetInvocationArrivalForTests();
  resetDeviceArrivalForTests();
  clearNotices();
  vi.restoreAllMocks();
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

/** Arrive as a link does: boot reads the address, then the app renders. */
function arrive(address: string) {
  history.replaceState(null, "", address);
  captureInvocationArrivalFromPage();
  return render(
    <BrowserRouter>
      <App slots={slots} />
    </BrowserRouter>,
  );
}

const openKey = () => screen.findByRole("link", { name: "Open OpenSesame" });

describe("/invoke/:kind before unlock", () => {
  for (const status of ["empty", "locked"]) {
    it(`hands an MFA code to the app on a ${status} device, key focused`, async () => {
      vault.status = status;
      arrive("/invoke/mfa?user_code=abcd-1234");
      const key = await openKey();
      expect(key.getAttribute("href")).toBe(
        "opensesame://invoke/mfa?user_code=ABCD-1234",
      );
      await waitFor(() => expect(document.activeElement).toBe(key));
      expect(location.search).toBe("");
      expect(
        screen.getByRole("heading", { name: "Approve with OpenSesame" }),
      ).toBeTruthy();
      expect(screen.getByText("ABCD-1234")).toBeTruthy();
      expect(screen.queryByText("unlock screen stub")).toBeNull();
      expect(screen.queryByTestId("app-shell")).toBeNull();
    });
  }

  it("falls back to /device with the code carried into its hand-off", async () => {
    vault.status = "empty";
    arrive("/invoke/mfa?user_code=abcd-1234");
    await openKey();
    await userEvent.click(
      screen.getByRole("link", { name: "Continue in this browser" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Approve a device" }),
    ).toBeTruthy();
    expect(peekDeviceArrival()).toEqual({
      kind: "code",
      userCode: "ABCD-1234",
    });
    await waitFor(() => expect(location.search).toBe(""));
    expect(location.pathname).toBe("/device");
  });

  it("offers only the hand-off for a wallet request, and fetches nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    arrive(
      "/invoke/oid4vp?request_uri=https%3A%2F%2Fverifier.example%2Frequest%2F1",
    );
    const key = await openKey();
    expect(key.getAttribute("href")).toBe(
      "openid4vp://?request_uri=https%3A%2F%2Fverifier.example%2Frequest%2F1",
    );
    expect(screen.getByText("verifier.example")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Continue in this browser" }),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind in ceremony-kit's words, on a mark and in the tray", async () => {
    arrive("/invoke/totp?user_code=AB");
    const refused = await screen.findByRole("region", {
      name: "OpenSesame did not open",
    });
    expect(
      screen.getByRole("img", { name: "Unknown authenticator request." }),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(refused));
    expect(screen.queryByRole("link", { name: "Open OpenSesame" })).toBeNull();
    expect(listNotices().find((n) => n.id === INVOCATION_NOTICE)?.body).toBe(
      "Unknown authenticator request.",
    );
    expect(location.search).toBe("");
  });

  it("refuses two handles in one link, as the parser does", async () => {
    arrive("/invoke/mfa?request_id=r1&user_code=AB");
    expect(
      await screen.findByRole("img", {
        name: "This link must contain exactly one request handle.",
      }),
    ).toBeTruthy();
  });
});
