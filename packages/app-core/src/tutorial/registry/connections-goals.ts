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
      'navigate "/connections"',
      'wait route "/connections" timeout=15000',
      'focus "connections.catalog" "GitHub backup is a field on the GitHub connection." side=bottom',
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
      'navigate "/settings/connections"',
      'wait route "/settings/connections" timeout=15000',
      'focus "settings.model-provider" "Pick one provider/model slug for voice and one for inference. Hosted providers appear after Agent Harnesses connects them." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.secret-config",
    title: "Set a secret-config value",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.secret-config"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/connections"',
      'wait route "/settings/connections" timeout=15000',
      'focus "settings.secret-configs" "Values go in and never come back out. The list is keys and metadata only." side=bottom',
      "end",
    ].join("\n"),
  },
  {
    id: "settings.sync",
    title: "Replicate the sealed store",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.sync"',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/connections"',
      'wait route "/settings/connections" timeout=15000',
      'focus "settings.sync-targets" "Each target is a replica of ciphertext. Triggering a run copies; it does not decrypt." side=bottom',
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
    id: "help.backup",
    title: "How do I back up the vault?",
    answer:
      "GitHub backup is a field on the GitHub connection. It is not a settings page.",
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
