import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { nativeVaultClassification } from "@opensesame/app-core/lib/native-vault-session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, expect, it, vi } from "vitest";
import { nativeAuthPopupRuntime } from "../../../modules/connectors.external/native-auth-popup-runtime.js";
import { bindNativeVaultRuntime } from "../../../modules/connectors.external/native-vault-runtime.js";
import {
  type NativeAuthorizationTicket,
  nativeConnectorController,
} from "./native-connector-controller.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./native-connector-integration.test-support.js";
import type { NativeConfigureInput } from "./native-connector-ui.js";

installConnectorIntegration();
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const input: NativeConfigureInput = {
  method: "oidc",
  displayName: "Vault lifetime fixture",
  parameters: {
    endpoint: "https://vault.example.org",
    namespace: "",
    auth_mount: "oidc",
    role: "browser-read",
  },
  credentials: {},
  requestedScopes: {},
  targetIds: {},
};

function browserFixture(withGuard = true) {
  const windows: {
    close: ReturnType<typeof vi.fn>;
    location: { replace: ReturnType<typeof vi.fn> };
  }[] = [];
  const open = vi.fn(() => {
    const popup = {
      opener: null,
      close: vi.fn(),
      location: { replace: vi.fn() },
    };
    windows.push(popup);
    return popup;
  });
  const events = new EventTarget();
  vi.stubGlobal("window", {
    location: new URL("https://selfhost.example"),
    open,
    postMessage: vi.fn(),
    document: new EventTarget(),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
  const fixture = connectorIntegration();
  bindNativeVaultRuntime(fixture.activation);
  const popup = nativeAuthPopupRuntime(
    fixture.activation,
    "https://selfhost.example/auth/native-connector.html",
    () => {
      if (fixture.activation.disposed()) throw new Error("Runtime disposed");
    },
  );
  const port = {
    ...popup,
    captureAuthorizationGuard: withGuard
      ? popup.captureAuthorizationGuard
      : undefined,
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
  };
  releases.push(bindNativeOAuthBrowserPort(port));
  const url = new URL("https://issuer.example.org/authorize");
  url.search = new URLSearchParams({
    state: "provider-lifetime-state-0123456789",
    nonce: "provider-lifetime-nonce",
    redirect_uri: "https://selfhost.example/auth/native-connector.html",
    response_type: "code",
  }).toString();
  fixture.route.respond = async () =>
    Response.json({ data: { auth_url: url.href } });
  return { ...fixture, popup, open, windows, port };
}

function observedController() {
  const started: NativeAuthorizationTicket[] = [];
  const retired: NativeAuthorizationTicket[] = [];
  const controller = nativeConnectorController(
    { id: "vault", refused: false },
    undefined,
    (ticket) => {
      started.push(ticket);
      return () => retired.push(ticket);
    },
  );
  return { controller, started, retired };
}

function holdRealConfigure() {
  const driver = nativeConnectorDriver("oidc", "vault");
  const configure = driver.configure;
  const committed = deferred<string>();
  const resume = deferred<void>();
  vi.spyOn(driver, "configure").mockImplementationOnce(async (draft) => {
    const view = await configure(draft);
    committed.resolve(view.connectionId);
    await resume.promise;
    return view;
  });
  return {
    driver,
    committed: committed.promise,
    resume: () => resume.resolve(),
  };
}

it.each([false, true])(
  "does not let cancelled configure A borrow B or replace its binding (same controller: %s)",
  async (sameController) => {
    const fixture = browserFixture();
    const first = observedController();
    const second = sameController ? first : observedController();
    const held = holdRealConfigure();
    const authorize = vi.spyOn(held.driver, "authorize");
    const a = first.controller.connect(input);
    const rejectedA = expect(a).rejects.toThrow("cancelled");
    const idA = await held.committed;
    first.controller.cancelAuthorization();
    first.controller.cancelAuthorization();
    const b = second.controller.connect(input);
    const rejectedB = expect(b).rejects.toThrow();
    try {
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(fixture.windows[1]?.location.replace).toHaveBeenCalledOnce(),
      );
      const guardB = fixture.popup.captureAuthorizationGuard?.();
      const idB = second.controller.load()?.connectionId;
      expect(idB).toBeTruthy();
      expect(idB).not.toBe(idA);
      held.resume();
      await rejectedA;
      expect(authorize).toHaveBeenCalledOnce();
      expect(second.controller.load()?.connectionId).toBe(idB);
      expect(() => guardB?.()).not.toThrow();
      expect(fixture.windows[1]?.close).not.toHaveBeenCalled();
      expect(loadNativeConnectorRecord(idA)?.privateState.pending).toEqual({});
      expect(readDeviceRows()).toHaveLength(2);
      expect(first.retired).toHaveLength(1);
      if (!sameController) first.controller.cancelAuthorization();
      expect(() => guardB?.()).not.toThrow();
    } finally {
      held.resume();
      second.controller.cancelAuthorization();
      await Promise.allSettled([a, b]);
      await rejectedB;
    }
    expect(second.retired).toHaveLength(sameController ? 2 : 1);
  },
);

it.each(["lock", "dispose"])(
  "rejects a real configure result after %s before accepting or authorizing it",
  async (withdrawal) => {
    const fixture = browserFixture();
    const observed = observedController();
    const held = holdRealConfigure();
    const authorize = vi.spyOn(held.driver, "authorize");
    const operation = observed.controller.connect(input);
    const rejected = expect(operation).rejects.toThrow();
    const id = await held.committed;
    if (withdrawal === "lock") vaultStore.lock({ recordLastVault: false });
    else fixture.activation.dispose();
    held.resume();
    await rejected;
    expect(observed.controller.load()).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
    expect(loadNativeConnectorRecord(id)?.privateState.pending).toEqual({});
    expect(observed.started[0]?.current()).toBe(false);
    expect(observed.retired).toEqual(observed.started);
  },
);

it("rejects old authorize completion before loading a replacement and preserves its popup", async () => {
  const fixture = browserFixture();
  const configured = observedController();
  const saved = await configured.controller.configure(input);
  const tickets: NativeAuthorizationTicket[] = [];
  const retired: NativeAuthorizationTicket[] = [];
  const controller = nativeConnectorController(
    { id: "vault", refused: false },
    saved.connectionId,
    (ticket) => {
      tickets.push(ticket);
      return () => retired.push(ticket);
    },
  );
  controller.load();
  const finish = deferred<void>();
  const entered = deferred<void>();
  const driver = nativeConnectorDriver("oidc", "vault");
  vi.spyOn(driver, "authorize").mockImplementationOnce(async () => {
    entered.resolve();
    await finish.promise;
  });
  const old = controller.authorize();
  const rejected = expect(old).rejects.toThrow("cancelled");
  await entered.promise;
  await updateNativeConnector(
    saved.connectionId,
    saved,
    nativeVaultClassification,
    (record) => {
      record.configuration.displayName = "External metadata revision";
      return record;
    },
  );
  tickets[0]?.cancel();
  const releaseB = fixture.popup.prepareAuthorization?.();
  const guardB = fixture.popup.captureAuthorizationGuard?.();
  finish.resolve();
  await rejected;
  controller.cancelAuthorization();
  expect(() => guardB?.()).not.toThrow();
  expect(fixture.windows[1]?.close).not.toHaveBeenCalled();
  expect(retired).toEqual(tickets);
  await expect(controller.configure(input)).rejects.toThrow(
    "reload and review",
  );
  releaseB?.();
});

it("enforces local cancellation without an optional browser guard", async () => {
  const fixture = browserFixture(false);
  const observed = observedController();
  const held = holdRealConfigure();
  const authorize = vi.spyOn(held.driver, "authorize");
  const pending = observed.controller.connect(input);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await held.committed;
  observed.started[0]?.cancel();
  held.resume();
  await rejected;
  expect(authorize).not.toHaveBeenCalled();
  expect(observed.controller.load()).toBeNull();
  expect(fixture.windows[0]?.close).toHaveBeenCalledOnce();
});

it("retires once when the lifecycle sink cancels synchronously", async () => {
  const fixture = browserFixture();
  const retired = vi.fn();
  const controller = nativeConnectorController(
    { id: "vault", refused: false },
    undefined,
    (ticket) => {
      ticket.cancel();
      return retired;
    },
  );
  await expect(controller.connect(input)).rejects.toThrow("cancelled");
  controller.cancelAuthorization();
  expect(retired).toHaveBeenCalledOnce();
  expect(fixture.windows[0]?.close).toHaveBeenCalledOnce();
  expect(readDeviceRows()).toEqual([]);
});

it("releases the real reservation when capture or lifecycle publication fails", async () => {
  const fixture = browserFixture();
  const sink = vi.fn(() => {
    throw new Error("Lifecycle refused");
  });
  const controller = nativeConnectorController(
    { id: "vault", refused: false },
    undefined,
    sink,
  );
  await expect(controller.connect(input)).rejects.toThrow("Lifecycle refused");
  expect(fixture.windows[0]?.close).toHaveBeenCalledOnce();
  expect(readDeviceRows()).toEqual([]);
  const release = fixture.popup.prepareAuthorization?.();
  expect(fixture.open).toHaveBeenCalledTimes(2);
  release?.();
  const fail = new Error("Guard capture failed");
  releases.push(
    bindNativeOAuthBrowserPort({
      ...fixture.port,
      captureAuthorizationGuard: () => {
        throw fail;
      },
    }),
  );
  await expect(controller.connect(input)).rejects.toBe(fail);
  expect(fixture.windows[2]?.close).toHaveBeenCalledOnce();
  expect(sink).toHaveBeenCalledOnce();
});

it("does not publish a second ticket when the real popup is already reserved", async () => {
  const fixture = browserFixture();
  const observed = observedController();
  const held = holdRealConfigure();
  const pending = observed.controller.connect(input);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await held.committed;
  await expect(observed.controller.connect(input)).rejects.toThrow(
    "current provider sign-in",
  );
  expect(observed.started).toHaveLength(1);
  expect(observed.started[0]?.current()).toBe(true);
  expect(fixture.windows[0]?.close).not.toHaveBeenCalled();
  observed.started[0]?.cancel();
  held.resume();
  await rejected;
  expect(observed.retired).toHaveLength(1);
});

it("does not reserve or publish a popup ticket for actual API-key verification", async () => {
  const fixture = browserFixture();
  fixture.route.respond = async () =>
    Response.json({ id: "notion-test-bot", name: "Fixture" });
  const sink = vi.fn(() => vi.fn());
  const controller = nativeConnectorController(
    { id: "notion", refused: false },
    undefined,
    sink,
  );
  const saved = await controller.connect({
    method: "api-key",
    displayName: "Notion fixture",
    parameters: {},
    credentials: { api_key: "private-notion-fixture-key" },
    requestedScopes: {},
    targetIds: {},
  });
  expect(saved.status).toBe("connected");
  expect(sink).not.toHaveBeenCalled();
  expect(fixture.open).not.toHaveBeenCalled();
});

it("retires no-prepare legacy cancellation without borrowing or cancelling a later popup", async () => {
  const fixture = browserFixture();
  const observed = observedController();
  const cancelLegacy = vi.fn(() => {
    observed.controller.cancelAuthorization();
    fixture.port.cancelAuthorization?.();
  });
  fixture.popup.prepareAuthorization?.();
  releases.push(
    bindNativeOAuthBrowserPort({
      ...fixture.port,
      prepareAuthorization: undefined,
      cancelAuthorization: cancelLegacy,
    }),
  );
  const held = holdRealConfigure();
  const authorize = vi.spyOn(held.driver, "authorize");
  const pending = observed.controller.connect(input);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await held.committed;
  observed.controller.cancelAuthorization();
  const releaseB = fixture.popup.prepareAuthorization?.();
  const guardB = fixture.popup.captureAuthorizationGuard?.();
  held.resume();
  await rejected;
  observed.controller.cancelAuthorization();
  expect(cancelLegacy).toHaveBeenCalledTimes(1);
  expect(fixture.windows[0]?.close).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();
  expect(observed.controller.load()).toBeNull();
  expect(observed.started).toEqual([]);
  expect(observed.retired).toEqual([]);
  expect(() => guardB?.()).not.toThrow();
  expect(fixture.windows[1]?.close).not.toHaveBeenCalled();
  releaseB?.();
});
