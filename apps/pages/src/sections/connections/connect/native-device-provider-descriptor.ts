import { hasConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
/** Device catalog configuration is distinct from a running browser connection. */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { isGitBackupProvider } from "@opensesame/app-core/lib/git-backup-forges.js";
import type { NativeMethod } from "@opensesame/app-core/lib/native-connector-schema.js";
import type {
  NativeConnectorDescriptor,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

export type NativeDeviceAvailability = {
  has: (method: NativeMethod, providerId: string) => boolean;
};

function existingSpecializedRoad(providerId: string): boolean {
  return (
    isGitBackupProvider(providerId) ||
    ["github", "aws-kms", "gcp-kms", "s3"].includes(providerId)
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

function requiresCompanion(provider: Provider): boolean {
  return (
    provider.category === "password_managers" ||
    provider.category === "local_storage"
  );
}

function resourceDescription(provider: Provider): string {
  const resources = (provider.configurationFields ?? [])
    .filter((field) => field.required && !field.secret)
    .map((field) => field.label.toLowerCase());
  return resources.length
    ? ` Its configuration identifies ${resources.join(", ")}.`
    : "";
}

function unavailableReason(provider: Provider): string {
  if (provider.id === "tailscale")
    return `${provider.displayName} device enrollment requires tailscaled and the OpenSesame native daemon. This browser cannot run those OS processes. Configure and pair the daemon using the provider setup guide; a saved auth key alone would not enroll a device.`;
  if (requiresCompanion(provider))
    return `The ${provider.displayName} catalog integration uses native application, OS or CLI access; this browser cannot run that companion and has no supported browser driver for it.${resourceDescription(provider)} Use the provider setup guide for companion configuration, or Vault → Import items for a supported export file. Imported items are a local snapshot, not a running ${provider.displayName} connection.`;
  if (provider.category === "wallet")
    return `${provider.displayName} provisioning is unavailable under this product's wallet connection policy. This browser has no wallet driver and does not collect signing or issuer credentials.${resourceDescription(provider)}`;
  return `${provider.displayName} has no supported browser driver for its catalog operations.${resourceDescription(provider)} Follow the provider setup guide for its native configuration. Saving configuration alone would not verify provider access, so this app does not offer a Connect action for this route.`;
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
  // Aliases retain their route identity; driver lookup still uses the compiled id.
  const method: NativeMethodDescriptor = ["vault", "openbao"].includes(
    provider.id,
  )
    ? instanceMethod(provider, availability)
    : {
        id: "native-local",
        label: "Companion configuration",
        available: false,
        unavailableReason: unavailableReason(provider),
        fields: [],
        scopeGroups: [],
      };
  return {
    providerId,
    name: provider.displayName,
    docsUrl: provider.docsUrl,
    methods: ["vault", "openbao"].includes(provider.id)
      ? [instanceSignIn(provider, availability), method]
      : [method],
    actions: [],
    configurationLinks: requiresCompanion(provider)
      ? [
          {
            label: "Open Vault to import a supported export",
            to: "/vault?f=all",
          },
        ]
      : [],
  };
}
