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
          {
            id: "backup_owner",
            label: "Backup repository owner",
            kind: "text",
            secret: false,
            required: false,
            help: "For vault backups, supply owner, repository and an existing branch. The token needs Contents read/write access.",
          },
          {
            id: "backup_repo",
            label: "Backup repository name",
            kind: "text",
            secret: false,
            required: false,
          },
          {
            id: "backup_branch",
            label: "Backup repository branch",
            kind: "text",
            secret: false,
            required: false,
            help: "Use an existing branch. Encrypted backup envelopes are limited to 512 KiB.",
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
