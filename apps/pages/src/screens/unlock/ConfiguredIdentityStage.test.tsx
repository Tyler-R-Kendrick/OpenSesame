/** @vitest-environment jsdom */
import { identityConnectionDraft } from "@opensesame/app-core/lib/identity-connections-presets.js";
import type { OperatorIdp } from "@opensesame/app-core/lib/settings.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ConfiguredIdentityStage,
  configuredIdentityDependencies as dependencies,
  startConfiguredIdentity,
} from "./ConfiguredIdentityStage.js";

beforeEach(() => {
  vi.spyOn(dependencies, "beginSavedNativeOidc").mockResolvedValue(undefined);
  vi.spyOn(dependencies, "beginSavedNativeSaml").mockResolvedValue(undefined);
  vi.spyOn(dependencies, "hydrateIdentityConnections").mockResolvedValue(
    undefined,
  );
  vi.spyOn(dependencies, "readIdentityConnection").mockReturnValue(
    identityConnectionDraft("better-auth"),
  );
  vi.spyOn(dependencies, "beginIdentityConnectionSignIn").mockResolvedValue(
    undefined,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function operator(overrides: Partial<OperatorIdp> = {}): OperatorIdp {
  return {
    providerId: "better-auth",
    issuer: "https://auth.example.com/api/auth",
    clientId: "better-auth",
    label: "Better Auth",
    connectionId: "idc_native",
    protocol: "better-auth",
    ...overrides,
  };
}

it("opens configured native credentials after hydration instead of trying OIDC discovery", async () => {
  const handlers = {
    open: vi.fn(),
    start: vi.fn(async (run: () => Promise<void>) => run()),
    legacy: vi.fn(),
    fail: vi.fn(),
  };
  startConfiguredIdentity(operator(), handlers);
  await waitFor(() =>
    expect(handlers.open).toHaveBeenCalledWith({
      id: "idc_native",
      draft: identityConnectionDraft("better-auth"),
    }),
  );
  expect(dependencies.hydrateIdentityConnections).toHaveBeenCalledOnce();
  expect(handlers.legacy).not.toHaveBeenCalled();
});

it("routes saved public OIDC through the shared adapter", async () => {
  vi.mocked(dependencies.readIdentityConnection).mockReturnValue(
    identityConnectionDraft("clerk"),
  );
  const handlers = {
    open: vi.fn(),
    start: vi.fn(async (run: () => Promise<void>) => run()),
    legacy: vi.fn(),
    fail: vi.fn(),
  };
  startConfiguredIdentity(operator({ protocol: "oidc" }), handlers);
  await waitFor(() =>
    expect(dependencies.beginIdentityConnectionSignIn).toHaveBeenCalledWith(
      "idc_native",
    ),
  );
  expect(handlers.open).not.toHaveBeenCalled();
  expect(dependencies.beginSavedNativeOidc).not.toHaveBeenCalled();
});

it("rejects a missing configuration after hydration without starting authentication", async () => {
  vi.mocked(dependencies.readIdentityConnection).mockReturnValue(null);
  const handlers = {
    open: vi.fn(),
    start: vi.fn(async (run: () => Promise<void>) => run()),
    legacy: vi.fn(),
    fail: vi.fn(),
  };
  startConfiguredIdentity(operator(), handlers);
  await waitFor(() =>
    expect(handlers.fail).toHaveBeenCalledWith(
      "Identity configuration is no longer available.",
    ),
  );
  expect(dependencies.beginIdentityConnectionSignIn).not.toHaveBeenCalled();
});

it("submits transient native credentials and keeps authentication errors retryable", async () => {
  const user = userEvent.setup();
  vi.mocked(dependencies.beginIdentityConnectionSignIn).mockRejectedValueOnce(
    new Error("Email or password refused"),
  );
  render(
    <ConfiguredIdentityStage
      connection={{
        id: "idc_native",
        draft: identityConnectionDraft("better-auth"),
      }}
      busy={false}
      setBusy={vi.fn()}
      back={<span>Back</span>}
      onComplete={vi.fn()}
    />,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
  await user.type(screen.getByLabelText("Email address"), "person@example.com");
  await user.type(screen.getByLabelText("Password"), "passphrase");
  await user.click(
    screen.getByRole("button", { name: "Sign in to Better Auth" }),
  );
  await screen.findByRole("img", { name: "Email or password refused" });
  expect(dependencies.beginIdentityConnectionSignIn).toHaveBeenCalledWith(
    "idc_native",
    { credentials: { email: "person@example.com", password: "passphrase" } },
  );
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  await user.type(screen.getByLabelText("Password"), "corrected");
  await user.click(
    screen.getByRole("button", { name: "Sign in to Better Auth" }),
  );
  await waitFor(() =>
    expect(dependencies.beginIdentityConnectionSignIn).toHaveBeenCalledTimes(2),
  );
});

it("waits for a cold saved connector to hydrate before deciding whether it exists", async () => {
  let hydrated = false;
  let completeHydration = () => {};
  vi.mocked(dependencies.hydrateIdentityConnections).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        completeHydration = () => {
          hydrated = true;
          resolve();
        };
      }),
  );
  vi.mocked(dependencies.readIdentityConnection).mockImplementation(() =>
    hydrated ? identityConnectionDraft("better-auth") : null,
  );
  const handlers = {
    open: vi.fn(),
    start: vi.fn(async (run: () => Promise<void>) => run()),
    legacy: vi.fn(),
    fail: vi.fn(),
  };
  startConfiguredIdentity(operator(), handlers);
  expect(dependencies.readIdentityConnection).not.toHaveBeenCalled();
  completeHydration();
  await waitFor(() =>
    expect(handlers.open).toHaveBeenCalledWith({
      id: "idc_native",
      draft: identityConnectionDraft("better-auth"),
    }),
  );
  expect(handlers.fail).not.toHaveBeenCalled();
});

it("returns successful native authentication to the caller's vault-key stage", async () => {
  const user = userEvent.setup();
  const onComplete = vi.fn();
  render(
    <ConfiguredIdentityStage
      connection={{
        id: "idc_native",
        draft: identityConnectionDraft("better-auth"),
      }}
      busy={false}
      setBusy={vi.fn()}
      back={<span>Back</span>}
      onComplete={onComplete}
    />,
  );
  await user.type(screen.getByLabelText("Email address"), "person@example.com");
  await user.type(screen.getByLabelText("Password"), "correct-password");
  await user.click(
    screen.getByRole("button", { name: "Sign in to Better Auth" }),
  );
  await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  expect(dependencies.beginIdentityConnectionSignIn).toHaveBeenCalledWith(
    "idc_native",
    {
      credentials: {
        email: "person@example.com",
        password: "correct-password",
      },
    },
  );
});

it("starts saved SAML in the initiating workflow before a deferred start handler or hydration", async () => {
  const order: string[] = [];
  let run: (() => Promise<void>) | undefined;
  vi.mocked(dependencies.beginSavedNativeSaml).mockImplementation(async () => {
    order.push("native-start");
  });
  startConfiguredIdentity(operator({ protocol: "saml" }), {
    open: vi.fn(),
    legacy: vi.fn(),
    fail: vi.fn(),
    start: (action) => {
      order.push("handler");
      run = action;
    },
  });
  expect(order).toEqual(["native-start", "handler"]);
  expect(dependencies.hydrateIdentityConnections).not.toHaveBeenCalled();
  expect(dependencies.readIdentityConnection).not.toHaveBeenCalled();
  expect(dependencies.beginSavedNativeSaml).toHaveBeenCalledExactlyOnceWith(
    "idc_native",
  );
  if (!run) throw new Error("Missing owned SAML workflow");
  await run();
  expect(dependencies.beginSavedNativeSaml).toHaveBeenCalledOnce();
});
it("delivers an original SAML refusal through the existing start error path", async () => {
  const error = new Error("Original native SAML owner changed");
  vi.mocked(dependencies.beginSavedNativeSaml).mockRejectedValue(error);
  let pending: Promise<void> | undefined;
  const open = vi.fn();
  const legacy = vi.fn();
  startConfiguredIdentity(operator({ protocol: "saml" }), {
    open,
    legacy,
    fail: vi.fn(),
    start: (action) => {
      pending = action();
    },
  });
  await expect(pending).rejects.toBe(error);
  expect(open).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
  expect(dependencies.hydrateIdentityConnections).not.toHaveBeenCalled();
});

it("captures native OIDC before a deferred handler and private hydration", async () => {
  const order: string[] = [];
  let run: (() => Promise<void>) | undefined;
  vi.mocked(dependencies.beginSavedNativeOidc).mockImplementation(async () => {
    order.push("native-start");
  });
  startConfiguredIdentity(
    operator({ protocol: "oidc", nativeIdentity: true }),
    {
      open: vi.fn(),
      legacy: vi.fn(),
      fail: vi.fn(),
      start: (action) => {
        order.push("handler");
        run = action;
      },
    },
  );
  expect(order).toEqual(["native-start", "handler"]);
  expect(dependencies.hydrateIdentityConnections).not.toHaveBeenCalled();
  expect(dependencies.readIdentityConnection).not.toHaveBeenCalled();
  expect(dependencies.beginSavedNativeOidc).toHaveBeenCalledExactlyOnceWith(
    "idc_native",
  );
  if (!run) throw new Error("Missing original OIDC workflow");
  await run();
  expect(dependencies.beginSavedNativeOidc).toHaveBeenCalledOnce();
});
it("preserves the original OIDC refusal without falling back to another route", async () => {
  const error = new Error("Original identity authority changed");
  vi.mocked(dependencies.beginSavedNativeOidc).mockRejectedValue(error);
  let pending: Promise<void> | undefined;
  const open = vi.fn();
  const legacy = vi.fn();
  startConfiguredIdentity(
    operator({ protocol: "oidc", nativeIdentity: true }),
    {
      open,
      legacy,
      fail: vi.fn(),
      start: (action) => {
        pending = action();
      },
    },
  );
  await expect(pending).rejects.toBe(error);
  expect(open).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
  expect(dependencies.hydrateIdentityConnections).not.toHaveBeenCalled();
  expect(dependencies.beginIdentityConnectionSignIn).not.toHaveBeenCalled();
});
