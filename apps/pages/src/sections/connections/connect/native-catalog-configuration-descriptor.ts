import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { nativeCatalogConfiguration } from "@opensesame/app-core/lib/native-catalog-configuration.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";

export function nativeCatalogConfigurationDescriptor(
  provider: Provider,
  available: boolean,
): NativeConnectorDescriptor | null {
  const contract = nativeCatalogConfiguration(provider.id);
  if (!contract) return null;
  return {
    providerId: provider.id,
    name: provider.displayName,
    docsUrl: provider.docsUrl,
    methods: [
      {
        id: "native-local",
        label: "Local configuration",
        available,
        unavailableKind: available ? undefined : "runtime-inactive",
        unavailableReason: available
          ? undefined
          : "Enable External connectors and open your own vault to save this configuration on this device.",
        instructions: `Enter the ${provider.displayName} configuration to validate and seal in this vault. Verification checks only the saved configuration; it makes no provider request and does not verify provider access or an account.`,
        fields: available
          ? (provider.configurationFields ?? []).map((field) => ({
              id: field.name,
              label: field.label,
              kind: "text",
              secret: field.secret,
              required: field.required,
              help: field.secret
                ? "Sealed in this vault and never rendered after saving."
                : undefined,
            }))
          : [],
        scopeGroups: [],
      },
    ],
    actions: [],
    disconnectExplanation:
      "Remove forgets this device's sealed configuration. It makes no provider request and does not revoke provider access or delete provider data.",
  };
}
