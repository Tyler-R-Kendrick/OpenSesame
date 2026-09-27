/**
 * Goals and authored help the `connectors.external` capability contributes
 * (`tutorial-goal` and help-topic contributions, registered on activation).
 */

import type { GuideGoalDescriptor, HelpTopic } from "./goals.js";

export const CONNECTIONS_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "connection.create",
    title: "Connect a provider",
    routes: [],
    guide: [
      "guide/1",
      'goal "connection.create"',
      'say "A provider connection is approved once. Every project and agent bound to it uses that authorization, and none of them ever holds the credential."',
      'navigate "/connections"',
      'wait route "/connections" timeout=15000',
      'focus "connections.provider-picker" "Find the provider here — a name, a category or a connector id all match." side=bottom',
      'wait target "connections.authorize" event=appear timeout=60000',
    ].join("\n"),
  },
  {
    id: "connection.repair",
    title: "Repair a broken connection",
    routes: [],
    guide: [
      "guide/1",
      'goal "connection.repair"',
      'say "A connection that only needs a fresh credential offers Renew. One the provider invalidated has to be authorized again."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/connections"',
      'wait route "/connections" timeout=15000',
      'focus "connections.attention" "Anything that needs a person is collected here." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.backup",
    title: "Configure backup",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.backup"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/capabilities"',
      'wait route "/settings/capabilities" timeout=15000',
      'focus "settings.backup" "Choose the git provider the vault backs up to under Backups, and switch it on." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.tailnet-sync",
    title: "Sync the vault with your other devices",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.tailnet-sync"',
      'say "Tailnet sync keeps this vault in step with your other devices through a drive on your own tailnet. The drive only ever holds the sealed vault. Switch Networking on under Settings, Capabilities first."',
      'navigate "/settings/vaults"',
      'wait route "/settings/vaults" timeout=15000',
      'focus "settings.tailnet-sync" "Paste the pairing code the drive printed, or open its link. On a new device this sets the vault up here, and its master password opens it." side=top',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.model-provider",
    title: "Choose voice and inference models",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.model-provider"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/capabilities"',
      'wait route "/settings/capabilities" timeout=15000',
      'focus "settings.model-provider" "Pick one provider/model slug for voice and one for inference. Hosted providers appear after Agent Harnesses connects them." side=bottom',
      "end",
    ].join("\n"),
  },
];

export const CONNECTIONS_HELP: readonly HelpTopic[] = [
  {
    id: "help.connection.create",
    title: "How do I connect a provider?",
    answer:
      "Connections → Add a connection. Search the catalog, open the provider's page, and approve it once on its Authorization panel. The credential is sealed with the connection; projects and agents are bound to the connection afterwards, and never receive the credential itself.",
    routes: [],
    goal: "connection.create",
    keywords: [
      "connection",
      "connect",
      "provider",
      "integration",
      "oauth",
      "authorize",
      "link",
      "catalog",
      "github",
      "google",
      "slack",
      "api",
    ],
  },
  {
    id: "help.connection.broken",
    title: "A connection stopped working. What now?",
    answer:
      "Open that connector's page from Connections. An authorization that only needs a fresh credential offers Renew now; one the provider has invalidated has to be authorized again. If the whole list fails to load, check connectivity on the statusline first.",
    routes: [],
    goal: "connection.repair",
    keywords: [
      "broken",
      "stopped working",
      "failed",
      "failing",
      "error",
      "renew",
      "expired",
      "revoked",
      "reauthorize",
      "fix",
      "repair",
      "not working",
    ],
  },
  {
    id: "help.tailnet-sync",
    title: "How do I sync the vault to my phone or another computer?",
    answer:
      "Run opensesame daemon drive create on a machine on your tailnet, switch Networking on in Settings → Capabilities, then paste its pairing code in Settings → Vaults on each device. Every device merges on its own side; the drive never holds a key.",
    routes: [],
    goal: "settings.tailnet-sync",
    keywords: [
      "sync",
      "tailscale",
      "tailnet",
      "phone",
      "another device",
      "enpass",
      "wi-fi sync",
      "pair",
    ],
  },
  {
    id: "help.backup",
    title: "How do I back up the vault?",
    answer:
      "Export, in the Vault's path strip, saves one encrypted backup file that the master password opens and Import restores. To keep a copy off this device, Settings → Capabilities → Backups: choose the git provider — GitHub, GitLab, Bitbucket, Codeberg or any git remote — the encrypted vault backs up to, and switch that provider on.",
    routes: [],
    goal: "settings.backup",
    keywords: [
      "backup",
      "back up",
      "export",
      "restore",
      "github",
      "sync",
      "copy",
      "another device",
      "recover",
      "move vault",
    ],
  },
];
