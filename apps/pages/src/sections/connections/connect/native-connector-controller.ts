/** The form delegates to one compiled provider driver and never receives saved credentials. */
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
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
import type {
  NativeConfigureInput,
  NativeConnectorController,
} from "./native-connector-ui.js";

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
      if (!view || !view.recovery.some((entry) => entry.id === recoveryId))
        return null;
      if (view.configuration.method === "mcp")
        return nativeMcpRevocationInstructions(view.connectionId, recoveryId);
      if (
        view.configuration.method === "oidc" &&
        ["vault", "openbao"].includes(view.providerId)
      )
        return nativeVaultRevocationInstructions(view.connectionId, recoveryId);
      return view.configuration.method === "oauth" &&
        nativeBrowserOAuthRecoverySettings(view.configuration)
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

export function nativeConnectorController(
  plan: Pick<ConnectPlan, "id" | "refused">,
  initialConnectionId?: string,
): NativeConnectorController {
  const state = nativeControllerState(plan, initialConnectionId);
  const { load, read, required, retain } = state;
  const configure = async (input: NativeConfigureInput) => {
    if (plan.refused)
      throw new Error("This provider connection is unavailable");
    const held = read() ? required() : null;
    if (held && held.configuration.method !== input.method)
      throw new Error(
        "Remove this connection before choosing another authorization method",
      );
    return retain(
      await nativeConnectorDriver(input.method, plan.id).configure({
        ...input,
        providerId: plan.id,
        connectionId: held?.connectionId,
        revision: held?.revision,
      }),
    );
  };
  const reserve = (method: NativeConfigureInput["method"]) =>
    ["oauth", "oidc", "mcp"].includes(method)
      ? nativeOAuthBrowserPort().prepareAuthorization?.()
      : undefined;
  return {
    load,
    configure,
    cancelAuthorization: () => nativeOAuthBrowserPort().cancelAuthorization?.(),
    connect: async (input) => {
      const release = reserve(input.method);
      try {
        const view = await configure(input);
        if (view.status === "connected") return view;
        const driver = nativeConnectorDriver(input.method, plan.id);
        if (!driver.authorize)
          throw new Error("This provider requires verified credentials");
        await driver.authorize(view.connectionId);
        const connected = load();
        if (!connected || connected.status !== "connected")
          throw new Error("Provider authorization did not complete");
        return connected;
      } finally {
        release?.();
      }
    },
    authorize: async (actor) => {
      const view = required();
      const release = reserve(view.configuration.method);
      try {
        const driver = nativeConnectorDriver(
          view.configuration.method,
          plan.id,
        );
        if (!driver.authorize)
          throw new Error("This method does not use provider consent");
        await driver.authorize(view.connectionId, actor);
        load();
      } finally {
        release?.();
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
    invoke: async (operationId, input) => {
      const view = required();
      if (view.status !== "connected")
        throw new Error("Verify this provider connection before using it");
      return nativeConnectorDriver(view.configuration.method, plan.id).invoke(
        view.connectionId,
        operationId,
        input,
      );
    },
    ...nativeRecoveryControls(state),
  };
}
