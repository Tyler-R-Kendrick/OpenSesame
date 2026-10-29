import { isAiConnectionProvider } from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  type BrowserUnavailableKind,
  browserDisposition,
} from "@opensesame/app-core/lib/browser-disposition.js";
import { hasConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
/** Device catalog configuration is distinct from a running browser connection. */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import { identityConnectionPreset } from "@opensesame/app-core/lib/identity-connections-presets.js";
import { nativeCatalogConfiguration } from "@opensesame/app-core/lib/native-catalog-configuration.js";
import {
  compiledApiKeyRoute,
  compiledOidcRoute,
} from "@opensesame/app-core/lib/native-connector-availability.js";
import {
  hasNativeConnectorDriver,
  nativeConnectorWithdrawn,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeMethod } from "@opensesame/app-core/lib/native-connector-schema.js";
import { nativeKeyDriverFor } from "@opensesame/app-core/lib/native-key-drivers.js";
import { isSecretBackendProvider } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { nativeCatalogConfigurationDescriptor } from "./native-catalog-configuration-descriptor.js";
import type {
  NativeConnectorDescriptor,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

export type NativeDeviceAvailability = {
  has: (method: NativeMethod, providerId: string) => boolean;
};

/** Production route availability for device catalog rows, by method. */
export function productionDeviceAvailability(
  apiKeyClosed: boolean,
): NativeDeviceAvailability {
  return {
    has: (method, id) =>
      !nativeConnectorWithdrawn(method) &&
      (method === "oidc"
        ? compiledOidcRoute(id)
        : method === "native-local"
          ? hasNativeConnectorDriver(method, id) &&
            vaultStore.isGenuineSession()
          : compiledApiKeyRoute(id) && !apiKeyClosed),
  };
}

function existingSpecializedRoad(providerId: string): boolean {
  return (
    isGitBackupProvider(providerId) ||
    identityConnectionPreset(providerId) !== null ||
    isSecretBackendProvider(providerId) ||
    isAiConnectionProvider(providerId) ||
    nativeKeyDriverFor(providerId) !== null ||
    ["github", "aws-kms", "gcp-kms", "s3", "tailscale"].includes(providerId)
  );
}

function instanceMethod(
  provider: Provider,
  availability: NativeDeviceAvailability,
): NativeMethodDescriptor {
  const available = availability.has("api-key", provider.id);
  return {
    id: "api-key",
    label: `${provider.displayName} token`,
    available,
    unavailableReason: `${provider.displayName} token verification is unavailable in this browser runtime.`,
    instructions: `Use a restricted ${provider.displayName} token for your own HTTPS instance. Allow this app's origin in the instance CORS policy. Access is verified with token lookup-self; provider policies determine permissions. Disconnect forgets the local token and does not revoke other uses of it.`,
    fields: available
      ? [
          {
            id: "endpoint",
            label: "Instance HTTPS origin",
            kind: "url",
            secret: false,
            required: true,
            placeholder: "https://vault.example.com",
            help: "Use the instance origin without a path, query or embedded credentials.",
          },
          {
            id: "namespace",
            label: "Namespace (optional)",
            kind: "text",
            secret: false,
            required: false,
            help: "Provider namespace used in the X-Vault-Namespace header, when required by your instance.",
          },
          {
            id: "api_key",
            label: "Provider token",
            kind: "text",
            secret: true,
            required: true,
            help: "Enter the token once. It is verified before being sealed on this device.",
          },
        ]
      : [],
    scopeGroups: [],
    links: [
      {
        label: `${provider.displayName} token verification`,
        url:
          provider.id === "vault"
            ? "https://developer.hashicorp.com/vault/api-docs/auth/token#lookup-a-token-self"
            : "https://openbao.org/api-docs/auth/token/#lookup-a-token-self",
      },
    ],
  };
}

function instanceSignIn(
  provider: Provider,
  availability: NativeDeviceAvailability,
): NativeMethodDescriptor {
  return {
    id: "oidc",
    label: "Sign in",
    available: availability.has("oidc", provider.id),
    authorizeFirst: true,
    authorizationActor: "user",
    fields: [
      {
        id: "endpoint",
        label: "Instance HTTPS origin",
        kind: "url",
        secret: false,
        required: true,
        placeholder: "https://vault.example.com",
      },
      {
        id: "auth_mount",
        label: "OIDC auth mount",
        kind: "text",
        secret: false,
        required: true,
        defaultValue: "oidc",
      },
      {
        id: "role",
        label: "Role (optional)",
        kind: "text",
        secret: false,
        required: false,
      },
      {
        id: "namespace",
        label: "Namespace (optional)",
        kind: "text",
        secret: false,
        required: false,
      },
    ],
    scopeGroups: [],
  };
}

/** What the method is called, by why it is unavailable: "companion" only where one would help. */
const METHOD_LABEL = {
  "built-in": "Built in",
  companion: "Companion configuration",
  "refuses-browser": "Direct browser access",
  "driver-pending": "Direct browser access",
  "runtime-inactive": "Connection activation",
  "no-key-check": "API key",
  "no-contract": "Browser connection",
  policy: "Not offered",
  "needs-client-secret": "OAuth",
  "no-public-contract": "Authorization",
} as const satisfies Record<BrowserUnavailableKind, string>;

function unavailableMethod(provider: Provider) {
  const disposition = browserDisposition(provider);
  const method = {
    id: "native-local",
    label: METHOD_LABEL[disposition.kind],
    available: false,
    unavailableKind: disposition.kind,
    unavailableReason: disposition.summary,
    fields: [],
    scopeGroups: [],
  } satisfies NativeMethodDescriptor;
  return { method, disposition };
}

/** Resolve the canonical catalog row without adding a second provider inventory. */
export function nativeDeviceProviderDescriptor(
  providerId: string,
  availability: NativeDeviceAvailability,
): NativeConnectorDescriptor | null {
  if (hasConnectPlan(providerId) || existingSpecializedRoad(providerId))
    return null;
  const provider = catalogProvider(providerId);
  if (!provider) return null;
  if (nativeCatalogConfiguration(provider.id)) {
    const configuration = nativeCatalogConfigurationDescriptor(
      provider,
      availability.has("native-local", provider.id),
    );
    if (configuration) return { ...configuration, providerId };
  }
  // Aliases retain their route identity; driver lookup still uses the compiled id.
  const instance = ["vault", "openbao"].includes(provider.id);
  if (instance) {
    const token = instanceMethod(provider, availability);
    return {
      providerId,
      name: provider.displayName,
      docsUrl: provider.docsUrl,
      methods: [instanceSignIn(provider, availability), token],
      actions: [],
    };
  }
  const { method, disposition } = unavailableMethod(provider);
  return {
    providerId,
    name: provider.displayName,
    docsUrl: provider.docsUrl,
    methods: [method],
    actions: [],
    // A source that is the documentation link is not a second link to it.
    externalLinks: disposition.sources.filter(
      (source) => source.url !== provider.docsUrl,
    ),
    configurationLinks: disposition.alternative
      ? [disposition.alternative]
      : [],
  };
}
