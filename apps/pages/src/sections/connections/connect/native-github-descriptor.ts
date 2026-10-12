import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type { NativeConnectorDescriptor } from "./native-connector-ui.js";

/** Personal tokens use GitHub's public browser API; App provisioning remains separate. */
export function nativeGithubDescriptor(
  provider: Provider,
  available: boolean,
): NativeConnectorDescriptor {
  return {
    providerId: provider.id,
    name: provider.displayName,
    docsUrl:
      "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    disconnectExplanation:
      "Disconnect forgets this device's token. Revoke the token in GitHub's settings to end its other uses.",
    methods: [
      {
        id: "api-key",
        label: "Personal access token",
        available,
        unavailableReason: available
          ? undefined
          : "GitHub personal-token access is unavailable in this browser runtime.",
        fields: [
          {
            id: "api_key",
            label: "GitHub personal access token",
            kind: "text",
            secret: true,
            required: true,
          },
        ],
        scopeGroups: [],
        links: [
          {
            label: "Create a fine-grained token",
            url: "https://github.com/settings/personal-access-tokens/new",
          },
          {
            label: "Create a classic token",
            url: "https://github.com/settings/tokens/new",
          },
        ],
      },
    ],
    actions: [],
  };
}
