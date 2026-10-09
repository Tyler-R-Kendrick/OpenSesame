/** Render one native provider contract and its verified connection, never a hosted service form. */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { hasNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { nativeMcpUnavailableReason } from "@opensesame/app-core/lib/native-mcp-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useMemo, useState } from "react";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import { NativeConnectorSummary } from "./NativeConnectorSummary.js";
import { NativeMcpTools } from "./NativeMcpTools.js";
import { nativeConnectorController } from "./native-connector-controller.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";
import { nativeDeviceProviderDescriptor } from "./native-device-provider-descriptor.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";

export function nativeSettingsDescriptor(
  provider: Provider,
): NativeConnectorDescriptor | null {
  if (["linear", "github"].includes(provider.id)) return null;
  const plan = connectPlan(provider.id);
  if (!plan)
    return nativeDeviceProviderDescriptor(provider.id, {
      has: hasNativeConnectorDriver,
    });
  const callbackUrl = new URL(
    `${import.meta.env.BASE_URL}auth/native-connector.html`,
    window.location.origin,
  ).href;
  const descriptor = nativeProviderDescriptor(plan, {
    callbackUrl,
    apiKey: { available: hasNativeConnectorDriver("api-key", provider.id) },
    oauth: {
      available: hasNativeConnectorDriver("oauth", provider.id),
      reason:
        provider.id === "google" &&
        !hasNativeConnectorDriver("oauth", provider.id)
          ? "Google's browser token popup requires opener access. This deployment enforces strict cross-origin isolation for the vault, so Google popup authorization is unavailable here."
          : undefined,
      profile: nativeBrowserOAuthProfile(provider.id) ?? undefined,
    },
    mcp: {
      available: hasNativeConnectorDriver("mcp", provider.id),
      reason: nativeMcpUnavailableReason(provider.id) ?? undefined,
      actor: "user",
    },
  });
  return descriptor;
}

function actions(
  descriptor: NativeConnectorDescriptor,
  view: NativeConnectorView | null,
): NativeConnectorDescriptor {
  return {
    ...descriptor,
    actions:
      view && view.configuration.method !== "mcp"
        ? [
            {
              id: "provider.read",
              label: `Check ${descriptor.name} access`,
              available: true,
              fields: [],
              resultOrigins: [],
            },
          ]
        : [],
  };
}

export function NativeConnectorPanels({
  provider,
  connection,
  onFlash,
  onChanged,
}: {
  provider: Provider;
  connection: Connection | null;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const descriptor = nativeSettingsDescriptor(provider);
  const controller = useMemo(
    () =>
      nativeConnectorController(
        {
          id: provider.id,
          refused: connectPlan(provider.id)?.refused ?? false,
        },
        connection?.connectionId,
      ),
    [provider.id, connection?.connectionId],
  );
  const [, refresh] = useState(0);
  const view = controller.load();
  if (!descriptor) return null;
  const current = actions(descriptor, view);
  const changed = (_next: NativeConnectorView | null) => {
    refresh((version) => version + 1);
    onChanged();
  };
  return (
    <div className="cx-setup">
      <section className="panel" id="connector" aria-label="Connector">
        <div className="panel__head">
          <h2>
            <span className="cx-step">2</span> Configure
          </h2>
        </div>
        <NativeConnectorForm
          key={`${provider.id}/${view?.connectionId ?? "new"}/${view?.revision ?? 0}`}
          descriptor={current}
          controller={controller}
          view={view}
          onFlash={onFlash}
          onChanged={changed}
        />
      </section>
      {view ? (
        <>
          <NativeConnectorSummary
            descriptor={current}
            controller={controller}
            view={view}
            onFlash={onFlash}
            onChanged={changed}
            onRemoved={() => changed(null)}
          />
          {view.configuration.method === "mcp" ? (
            <NativeMcpTools
              view={view}
              controller={controller}
              onFlash={onFlash}
              onChanged={changed}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
