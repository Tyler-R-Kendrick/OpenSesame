/** The form delegates to one compiled provider driver and never receives saved credentials. */
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  attestNativeBrowserOAuthRevocation,
  nativeBrowserOAuthRecoverySettings,
  nativeBrowserOAuthRevocationInstructions,
} from "@opensesame/app-core/lib/native-browser-oauth-attestation.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import {
  attestNativeMcpRevocation,
  nativeMcpRevocationInstructions,
} from "@opensesame/app-core/lib/native-mcp-attestation.js";
import { nativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import {
  attestNativeVaultRevocation,
  nativeVaultRevocationInstructions,
} from "@opensesame/app-core/lib/native-vault-attestation.js";
import {
  authorizationAttempt,
  authorizationCorrelation,
} from "./native-authorization-ticket.js";
import type {
  NativeConfigureInput,
  NativeConnectorController,
} from "./native-connector-ui.js";

/** This capability closes one reserved popup; it conveys no connector authority. */
export type NativeAuthorizationTicket = Readonly<{
  method: NativeConfigureInput["method"];
  cancel(): void;
  current(): boolean;
  selectConnection?(connectionId?: string): void;
}>;
export type NativeAuthorizationSink = (
  ticket: NativeAuthorizationTicket,
) => () => void;

type AuthorizationAttempt = ReturnType<typeof authorizationAttempt>;

function authorizationLifetime(
  providerId: string,
  read: () => NativeConnectorView | null,
  staleId: string | undefined,
  sink?: NativeAuthorizationSink,
) {
  let current: AuthorizationAttempt | undefined;
  const reserve = (method: NativeConfigureInput["method"]) => {
    if (!["oauth", "oidc", "mcp"].includes(method)) return;
    const correlation = authorizationCorrelation({
      initial: read()?.connectionId,
      stale: staleId,
      existing: new Set(readDeviceRows().map((row) => row.connectionId)),
      read: (id) => {
        const view = readNativeConnector(id);
        return !view
          ? "absent"
          : view.providerId === providerId
            ? "same-provider"
            : "other-provider";
      },
    });
    const browser = nativeOAuthBrowserPort();
    const release = browser.prepareAuthorization?.();
    let stop: (() => void) | undefined;
    const retire = () => {
      if (current === attempt) current = undefined;
      const cleanup = stop;
      stop = undefined;
      cleanup?.();
    };
    // The local flag also protects ports that do not expose a browser guard.
    let capturedGuard: (() => void) | undefined;
    const attempt = authorizationAttempt(
      release,
      browser.cancelAuthorization,
      () => capturedGuard?.(),
      retire,
      correlation,
    );
    try {
      capturedGuard = browser.captureAuthorizationGuard?.();
      current = attempt;
      if (release)
        stop = sink?.(
          Object.freeze({
            method,
            cancel: attempt.cancel,
            current: attempt.current,
            selectConnection: attempt.selectConnection,
          }),
        );
      if (!attempt.current()) retire();
      attempt.check();
      return attempt;
    } catch (error) {
      attempt.finish();
      throw error;
    }
  };
  return {
    reserve,
    cancel: () => current?.cancel(),
  };
}

function nativeControllerState(
  plan: Pick<ConnectPlan, "id" | "refused">,
  initialConnectionId?: string,
) {
  let connectionId = initialConnectionId;
  let rendered: { revision: number; fingerprint: string } | null = null;
  const read = () => {
    if (!connectionId) return null;
    const view = readNativeConnector(connectionId);
    if (view && view.providerId !== plan.id)
      throw new Error("This connection belongs to another provider");
    return view;
  };
  const accept = (view: NativeConnectorView | null) => {
    rendered = view
      ? { revision: view.revision, fingerprint: view.configuration.fingerprint }
      : null;
    return view;
  };
  const load = () => accept(read());
  const required = () => {
    const view = read();
    if (!view) throw new Error("Save this provider's configuration first");
    if (
      !rendered ||
      rendered.revision !== view.revision ||
      rendered.fingerprint !== view.configuration.fingerprint
    )
      throw new Error(
        "This connection changed; reload and review it before continuing",
      );
    return view;
  };
  const retain = (view: NativeConnectorView) => {
    if (view.providerId !== plan.id)
      throw new Error("Provider returned another connection binding");
    connectionId = view.connectionId;
    accept(view);
    return view;
  };
  return {
    load,
    read,
    required,
    retain,
    forget: () => {
      connectionId = undefined;
      rendered = null;
    },
  };
}

function nativeRecoveryControls(
  state: ReturnType<typeof nativeControllerState>,
) {
  const { read, required, retain, forget } = state;
  return {
    retry: async (recoveryId: string) => {
      const view = required();
      if (!view.recovery.some((entry) => entry.id === recoveryId))
        throw new Error("Reload this connection before retrying cleanup");
      return retain(await retryNativeConnectorCleanup(view.connectionId));
    },
    revocationInstructions: (recoveryId: string) => {
      const view = read();
      const entry = view?.recovery.find((item) => item.id === recoveryId);
      if (!view || !entry) return null;
      if (view.configuration.method === "mcp")
        return nativeMcpRevocationInstructions(view.connectionId, recoveryId);
      if (
        view.configuration.method === "oidc" &&
        ["vault", "openbao"].includes(view.providerId)
      ) {
        // Vault has no issued-token revocation instruction before exchange preparation.
        return entry.kind === "configure"
          ? null
          : nativeVaultRevocationInstructions(view.connectionId, recoveryId);
      }
      return view.configuration.method === "oauth" &&
        nativeBrowserOAuthRecoverySettings(view.configuration) !== null
        ? nativeBrowserOAuthRevocationInstructions(
            view.connectionId,
            recoveryId,
          )
        : null;
    },
    confirmRevocation: async (recoveryId: string) => {
      const view = required();
      if (view.configuration.method === "mcp")
        return retain(
          await attestNativeMcpRevocation(view.connectionId, recoveryId),
        );
      if (
        view.configuration.method === "oidc" &&
        ["vault", "openbao"].includes(view.providerId)
      )
        return retain(
          await attestNativeVaultRevocation(view.connectionId, recoveryId),
        );
      if (view.configuration.method !== "oauth")
        throw new Error("This provider requires its own cleanup operation");
      return retain(
        await attestNativeBrowserOAuthRevocation(view.connectionId, recoveryId),
      );
    },
    remove: async () => {
      await removeNativeConnectorWithCleanup(required().connectionId);
      if (read())
        throw new Error("Provider connection removal was not committed");
      forget();
    },
  };
}

function nativeConfigure(
  plan: Pick<ConnectPlan, "id" | "refused">,
  state: ReturnType<typeof nativeControllerState>,
) {
  const { read, required, retain } = state;
  const configure = async (
    input: NativeConfigureInput,
    check?: () => void,
    bind?: (id: string) => void,
  ) => {
    check?.();
    if (plan.refused)
      throw new Error("This provider connection is unavailable");
    const held = read() ? required() : null;
    if (held && held.configuration.method !== input.method)
      throw new Error(
        "Remove this connection before choosing another authorization method",
      );
    const configured = await nativeConnectorDriver(
      input.method,
      plan.id,
    ).configure({
      ...input,
      providerId: plan.id,
      connectionId: held?.connectionId,
      revision: held?.revision,
    });
    bind?.(configured.connectionId);
    check?.();
    return retain(configured);
  };
  return configure;
}

export function nativeConnectorController(
  plan: Pick<ConnectPlan, "id" | "refused">,
  initialConnectionId?: string,
  onAuthorization?: NativeAuthorizationSink,
): NativeConnectorController {
  const state = nativeControllerState(plan, initialConnectionId);
  const { load, read, required, retain } = state;
  const lifetime = authorizationLifetime(
    plan.id,
    read,
    initialConnectionId,
    onAuthorization,
  );
  const configure = nativeConfigure(plan, state);
  const test = async (input: NativeConfigureInput) => {
    if (plan.refused)
      throw new Error("This provider connection is unavailable");
    const driver = nativeConnectorDriver(input.method, plan.id);
    if (!driver.test)
      throw new Error("This provider verifies only when it is saved");
    return driver.test({ ...input, providerId: plan.id });
  };
  return {
    load,
    configure,
    test,
    cancelAuthorization: lifetime.cancel,
    connect: async (input) => {
      const attempt = lifetime.reserve(input.method);
      try {
        const view = await configure(input, attempt?.check, attempt?.bind);
        attempt?.check();
        if (view.status === "connected") return view;
        const driver = nativeConnectorDriver(input.method, plan.id);
        if (!driver.authorize)
          throw new Error("This provider requires verified credentials");
        await driver.authorize(view.connectionId);
        attempt?.check();
        const connected = load();
        if (!connected || connected.status !== "connected")
          throw new Error("Provider authorization did not complete");
        return connected;
      } finally {
        attempt?.finish();
      }
    },
    authorize: async (actor) => {
      const view = required();
      const attempt = lifetime.reserve(view.configuration.method);
      try {
        const driver = nativeConnectorDriver(
          view.configuration.method,
          plan.id,
        );
        if (!driver.authorize)
          throw new Error("This method does not use provider consent");
        await driver.authorize(view.connectionId, actor);
        attempt?.check();
        load();
      } finally {
        attempt?.finish();
      }
    },
    verify: async () => {
      const view = required();
      return retain(
        await nativeConnectorDriver(view.configuration.method, plan.id).verify(
          view.connectionId,
        ),
      );
    },
    invoke: async (operationId, input, signal) => {
      signal?.throwIfAborted();
      const view = required();
      if (view.status !== "connected")
        throw new Error("Verify this provider connection before using it");
      const driver = nativeConnectorDriver(view.configuration.method, plan.id);
      const result = await (signal === undefined
        ? driver.invoke(view.connectionId, operationId, input)
        : driver.invoke(view.connectionId, operationId, input, signal));
      signal?.throwIfAborted();
      return result;
    },
    ...nativeRecoveryControls(state),
  };
}
