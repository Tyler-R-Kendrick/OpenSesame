/** Render one native provider contract and its verified connection, never a hosted service form. */
import { nativeGoogleBrowserAvailable } from "@opensesame/app-core/browser/native-google-oauth.js";
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { nativeApiResourceActions } from "@opensesame/app-core/lib/native-api-resources.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import {
  compiledApiKeyRoute,
  compiledOidcRoute,
} from "@opensesame/app-core/lib/native-connector-availability.js";
import {
  hasNativeConnectorDriver,
  nativeConnectorWithdrawn,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { nativeKeyDriverFor } from "@opensesame/app-core/lib/native-key-drivers.js";
import { supportsConfiguredMcp } from "@opensesame/app-core/lib/native-mcp-configured-config.js";
import { nativeMcpUnavailableReason } from "@opensesame/app-core/lib/native-mcp-connectors.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { useNativeBridge } from "../../../lib/use-native-bridge.js";
import {
  nativeOAuthClientConfigured,
  supportsNativeOAuthResource,
} from "../../../modules/connectors.external/native-oauth-resource-runtime.js";
import { ConnectorPanel } from "./ConnectorPanel.js";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import { NativeConnectorSummary } from "./NativeConnectorSummary.js";
import { NativeMcpTools } from "./NativeMcpTools.js";
import { NativeVaultBackupControls } from "./NativeS3BackupControls.js";
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

function mcpInactiveReason(): string | undefined {
  if (vaultStore.isGenuineSession()) return undefined;
  return "Open your own vault to connect this provider. Guest sessions do not store provider credentials.";
}

export function nativeSettingsDescriptor(
  provider: Provider,
  savedMethod?: NativeConnectorView["configuration"]["method"],
): NativeConnectorDescriptor | null {
  // The compiled contract decides what this device can configure; a runtime
  // that was activated and then withdrawn closes its road again (ADR 0142).
  const closed = nativeConnectorWithdrawn("api-key");
  if (provider.id === "github")
    return nativeGithubDescriptor(
      provider,
      compiledApiKeyRoute(provider.id) && !closed,
    );
  if (provider.id === "s3")
    return nativeS3Descriptor(
      provider,
      compiledApiKeyRoute(provider.id) && !closed,
    );
  const keyed = nativeKeyDriverFor(provider.id);
  if (keyed)
    return nativeKeyDescriptor(
      provider,
      compiledApiKeyRoute(provider.id) && !closed,
      keyed.ui(provider.id),
    );
  const plan = connectPlan(provider.id);
  if (!plan)
    return nativeDeviceProviderDescriptor(provider.id, {
      has: (method, id) =>
        method === "oidc"
          ? compiledOidcRoute(id) && !nativeConnectorWithdrawn(method)
          : compiledApiKeyRoute(id) && !closed,
    });
  const callbackUrl = new URL(
    `${import.meta.env.BASE_URL}auth/native-connector.html`,
    window.location.origin,
  ).href;
  const descriptor = nativeProviderDescriptor(
    plan,
    {
      callbackUrl,
      apiKey: {
        available: compiledApiKeyRoute(provider.id) && !closed,
      },
      oauth: {
        registeredAvailable:
          hasNativeConnectorDriver("oauth", provider.id) &&
          supportsNativeOAuthResource(provider.id),
        available:
          supportsNativeOAuthResource(provider.id) &&
          !nativeConnectorWithdrawn("oauth") &&
          (provider.id !== "google" || nativeGoogleBrowserAvailable()),
        reason:
          provider.id === "google" && !nativeGoogleBrowserAvailable()
            ? "Google consent is unavailable under this deployment's isolation policy."
            : undefined,
        profile: nativeBrowserOAuthProfile(provider.id) ?? undefined,
      },
      mcp: {
        // Linear's authorization is its own specialized ceremony: it draws
        // only when its owner runtime is actually active, never invented.
        available:
          (provider.id === "linear"
            ? hasNativeConnectorDriver("mcp", provider.id)
            : supportsConfiguredMcp(provider.id)) &&
          !nativeConnectorWithdrawn("mcp"),
        reason: nativeMcpUnavailableReason(provider.id) ?? undefined,
        inactiveReason: mcpInactiveReason(),
        actor: "user",
        defaultScopes: provider.id === "linear" ? ["read"] : undefined,
      },
    },
    savedMethod,
  );
  // Linear's GraphQL app/key ceremony lives in its existing advanced form.
  // Existing native records keep their own method and credential custody.
  return provider.id === "linear"
    ? {
        ...descriptor,
        methods: descriptor.methods.filter(
          (method) => method.id === (savedMethod ?? "mcp"),
        ),
      }
    : descriptor;
}

function primaryActions(
  view: NativeConnectorView,
  name: string,
): readonly NativeActionDescriptor[] {
  const configured = nativeOAuthClientConfigured(view.configuration);
  if (configured && view.configuration.parameters.resource_protocol === "mcp")
    return [];
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
  const target = view.configuration.parameters;
  const supported =
    ["s3", "azure-sm", "azure-key-vault-secrets"].includes(view.providerId) ||
    (["github", "codeberg", "bitbucket"].includes(view.providerId) &&
      !!target.backup_owner &&
      !!target.backup_repo &&
      !!target.backup_branch) ||
    (view.providerId === "gitlab" &&
      view.configuration.method === "api-key" &&
      !!target.backup_project &&
      !!target.backup_branch);
  return supported && nativeVerified(view) ? (
    <NativeVaultBackupControls
      key={`${view.connectionId}/${view.revision}/${view.fingerprint}`}
      view={view}
      onFlash={onFlash}
    />
  ) : null;
}

function usesMcp(view: NativeConnectorView) {
  return (
    view.configuration.method === "mcp" ||
    (nativeOAuthClientConfigured(view.configuration) &&
      view.configuration.parameters.resource_protocol === "mcp")
  );
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
  const descriptor = nativeSettingsDescriptor(
    provider,
    view?.configuration.method,
  );
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
      <ConnectorPanel
        step={2}
        title={view && nativeVerified(view) ? "Configure" : "Connect"}
        focus
      >
        {renderConfiguration ? renderConfiguration(form) : form}
      </ConnectorPanel>
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
          {usesMcp(view) ? (
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
