/** Render one native provider contract and its verified connection, never a hosted service form. */
import { nativeGoogleBrowserAvailable } from "@opensesame/app-core/browser/native-google-oauth.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { nativeApiResourceActions } from "@opensesame/app-core/lib/native-api-resources.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { hasNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { nativeKeyDriverFor } from "@opensesame/app-core/lib/native-key-drivers.js";
import { nativeMcpUnavailableReason } from "@opensesame/app-core/lib/native-mcp-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { useNativeBridge } from "../../../lib/use-native-bridge.js";
import { nativeOAuthClientConfigured } from "../../../modules/connectors.external/native-oauth-resource-runtime.js";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import { NativeConnectorSummary } from "./NativeConnectorSummary.js";
import { NativeMcpTools } from "./NativeMcpTools.js";
import { NativeS3BackupControls } from "./NativeS3BackupControls.js";
import { nativeConnectorController } from "./native-connector-controller.js";
import { nativeVerified } from "./native-connector-ui-values.js";
import type {
  NativeActionDescriptor,
  NativeConnectorDescriptor,
} from "./native-connector-ui.js";
import { nativeDeviceProviderDescriptor } from "./native-device-provider-descriptor.js";
import { nativeGithubDescriptor } from "./native-github-descriptor.js";
import {
  nativeKeyActions,
  nativeKeyDescriptor,
} from "./native-key-descriptor.js";
import { nativeProviderDescriptor } from "./native-provider-descriptor.js";
import { nativeS3Descriptor } from "./native-s3-descriptor.js";
import { useNativeAuthorization } from "./useNativeAuthorization.js";

function nativeKeyActionsFor(providerId: string) {
  const keyed = nativeKeyDriverFor(providerId);
  return keyed ? nativeKeyActions(keyed.ui(providerId)) : [];
}

function discordActions(view: NativeConnectorView) {
  if (
    view.providerId !== "discord" ||
    !view.grants.some(
      (grant) =>
        grant.actor === "user" && grant.grantedScopes.includes("guilds"),
    )
  )
    return [];
  return [
    {
      id: "provider.guilds.read",
      label: "List servers",
      available: true,
      fields: [],
      resultOrigins: ["https://discord.com"],
    },
  ];
}

export function nativeSettingsDescriptor(
  provider: Provider,
): NativeConnectorDescriptor | null {
  if (provider.id === "linear") return null;
  if (provider.id === "github")
    return nativeGithubDescriptor(
      provider,
      hasNativeConnectorDriver("api-key", provider.id),
    );
  if (provider.id === "s3")
    return nativeS3Descriptor(
      provider,
      hasNativeConnectorDriver("api-key", provider.id),
    );
  const keyed = nativeKeyDriverFor(provider.id);
  if (keyed)
    return nativeKeyDescriptor(
      provider,
      hasNativeConnectorDriver("api-key", provider.id),
      keyed.ui(provider.id),
    );
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
      available:
        hasNativeConnectorDriver("oauth", provider.id) &&
        (provider.id !== "google" || nativeGoogleBrowserAvailable()),
      reason:
        provider.id === "google" && !nativeGoogleBrowserAvailable()
          ? "Google consent is unavailable under this deployment's isolation policy."
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

function primaryActions(
  view: NativeConnectorView,
  name: string,
): readonly NativeActionDescriptor[] {
  const configured = nativeOAuthClientConfigured(view.configuration);
  const resources = configured
    ? [{ id: "provider.resource.read", label: "Read configured API resource" }]
    : nativeApiResourceActions(view.providerId, view.configuration.method);
  const actions = resources.length
    ? resources
    : [{ id: "provider.read", label: `Check ${name} access` }];
  return actions.map((action) => ({
    ...action,
    available: true,
    fields: [],
    resultOrigins: [],
  }));
}

function actions(
  descriptor: NativeConnectorDescriptor,
  view: NativeConnectorView | null,
): NativeConnectorDescriptor {
  const available =
    !!view &&
    descriptor.methods.some(
      (method) => method.id === view.configuration.method && method.available,
    ) &&
    hasNativeConnectorDriver(view.configuration.method, view.providerId);
  return {
    ...descriptor,
    actions:
      view && view.configuration.method !== "mcp"
        ? [
            ...primaryActions(view, descriptor.name),
            ...(["vault", "openbao"].includes(descriptor.providerId)
              ? [
                  {
                    id: "provider.secret.read",
                    label: "Read secret",
                    available: true,
                    fields: [
                      {
                        id: "mount",
                        label: "KV v2 mount",
                        kind: "text" as const,
                        secret: false,
                        required: true,
                        defaultValue: "secret",
                      },
                      {
                        id: "path",
                        label: "Secret path",
                        kind: "text" as const,
                        secret: false,
                        required: true,
                        placeholder: "app/config",
                      },
                    ],
                    resultOrigins: [],
                  },
                ]
              : []),
            ...(["codeberg", "github"].includes(descriptor.providerId)
              ? [
                  {
                    id: "provider.repositories.read",
                    label: "Read repositories",
                    available: true,
                    fields: [],
                    resultOrigins: [
                      descriptor.providerId === "github"
                        ? "https://github.com"
                        : "https://codeberg.org",
                    ],
                  },
                ]
              : []),
            ...(descriptor.providerId === "s3"
              ? [
                  {
                    id: "provider.objects.read",
                    label: "List object keys",
                    available: true,
                    fields: [],
                    resultOrigins: [],
                  },
                ]
              : []),
            ...nativeKeyActionsFor(descriptor.providerId),
            ...discordActions(view),
          ].map((action) => ({
            ...action,
            available,
            reason: available
              ? undefined
              : "This provider action is unavailable in this browser runtime.",
          }))
        : [],
  };
}

function backupControls(
  view: NativeConnectorView,
  onFlash: (flash: Flash) => void,
) {
  return view.providerId === "s3" && nativeVerified(view) ? (
    <NativeS3BackupControls
      key={`${view.connectionId}/${view.revision}/${view.fingerprint}`}
      view={view}
      onFlash={onFlash}
    />
  ) : null;
}

export function NativeConnectorPanels({
  provider,
  connection,
  onFlash,
  onChanged,
  renderConfiguration,
}: {
  provider: Provider;
  connection: Connection | null;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  renderConfiguration?: (form: ReactNode) => ReactNode;
}) {
  // The connector bridge changes what a refused provider offers (ADR 0199).
  useNativeBridge(provider.id);
  const descriptor = nativeSettingsDescriptor(provider);
  const pending = useNativeAuthorization(provider.id, connection?.connectionId);
  const controller = useMemo(
    () =>
      nativeConnectorController(
        {
          id: provider.id,
          refused: connectPlan(provider.id)?.refused ?? false,
        },
        connection?.connectionId,
        pending.onAuthorization,
      ),
    [provider.id, connection?.connectionId, pending.onAuthorization],
  );
  const [, refresh] = useState(0);
  const view = controller.load();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === "#connector" || hash === "#complete") {
      document.getElementById(hash.slice(1))?.focus();
    }
  }, [hash]);
  if (!descriptor) return null;
  const current = actions(descriptor, view);
  // A road that opens or closes (the bridge arriving, a host allowed in it) is a new form.
  const roads = current.methods
    .map((method) => (method.available ? 1 : 0))
    .join("");
  const changed = (_next: NativeConnectorView | null) => {
    refresh((version) => version + 1);
    onChanged();
  };
  const form = (
    <NativeConnectorForm
      key={`${provider.id}/${view?.connectionId ?? "new"}/${view?.revision ?? 0}/${roads}/${pending.generation}`}
      descriptor={current}
      controller={controller}
      view={view}
      authorization={pending.authorization}
      onFlash={onFlash}
      onChanged={changed}
    />
  );
  return (
    <div className="cx-setup">
      <section
        className="panel"
        id="connector"
        aria-label="Connector"
        tabIndex={-1}
      >
        <div className="panel__head">
          <h2>
            <span className="cx-step">2</span>{" "}
            {view && nativeVerified(view) ? "Configure" : "Connect"}
          </h2>
        </div>
        {renderConfiguration ? renderConfiguration(form) : form}
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
            authorization={pending.authorization}
          />
          {backupControls(view, onFlash)}
          {view.configuration.method === "mcp" ? (
            <NativeMcpTools
              view={view}
              controller={controller}
              onFlash={onFlash}
              onChanged={changed}
              disabled={!!pending.authorization}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
