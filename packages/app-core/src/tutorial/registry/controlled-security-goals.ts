import type { GuideGoalDescriptor, HelpTopic } from "./goal-types.js";
export const CONTROLLED_SECURITY_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "vaults.controlled-canaries",
    title: "Set up controlled canaries",
    routes: [],
    requires: ["vault.unlocked"],
    guide: [
      "guide/1",
      'goal "vaults.controlled-canaries"',
      'say "Only the current owner of an unlocked real vault can manage this feature."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.security.canaries" "Manage opens the set up controlled canaries ceremony. You choose each action; this guide never submits it." side=bottom',
      'say "Create an issuer-generated controlled reference or export its synthetic MCP configuration. These artifacts never authorize production connections. Register an export with a controlled validator before testing it. Retire an issued generation only when a trusted issuer is configured; choose its public record reference and authenticate afresh. Never paste a production vendor key."',
      "end",
    ].join("\n"),
  },
  {
    id: "vaults.observation-receiver",
    title: "Configure an observation receiver",
    routes: [],
    requires: ["vault.unlocked"],
    guide: [
      "guide/1",
      'goal "vaults.observation-receiver"',
      'say "Only the current owner of an unlocked real vault can manage this feature."',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.security.receiver" "Manage opens the configure an observation receiver ceremony. You choose each action; this guide never submits it." side=bottom',
      'say "Delivery is optional. Independently obtain your HTTPS receiver endpoint, private pairing key, fixed binding and canary job reference. Review them in the owner ceremony and authenticate afresh to save. Keep the 64-byte AES/HMAC pairing key secret. Run the bounded test deliberately and verify its authenticated acknowledgment before enabling delivery; delivery does not prove hostile intent and local browser evidence is not independently trustworthy."',
      "end",
    ].join("\n"),
  },
];
export const CONTROLLED_SECURITY_HELP: readonly HelpTopic[] = [
  {
    id: "help.vaults.controlled-canaries",
    title: "Set up controlled canaries",
    answer:
      "Settings \u2192 Security \u2192 Controlled canaries. Manage opens the owner ceremony. Create a controlled reference or synthetic MCP artifact with fresh owner authentication. An exported artifact needs a registered validator to produce observations. Retired issuer generations require a configured trusted issuer and a public record reference. No production secrets or connector authority are granted.",
    routes: ["/settings/security"],
    goal: "vaults.controlled-canaries",
    keywords: ["canary", "detection", "receiver", "sealed evidence"],
  },
  {
    id: "help.vaults.observation-receiver",
    title: "Configure an observation receiver",
    answer:
      "Settings \u2192 Security \u2192 Observation receiver. Manage opens the owner ceremony for an independently supplied HTTPS receiver and private pairing key. Review the binding and job reference, then authenticate afresh to configure it. Keep the 64-byte AES/HMAC pairing key secret and out of logs. Test must return a genuine authenticated acknowledgment before delivery can be enabled; test and flush are deliberate bounded actions. Closed sealed metadata excludes submitted credentials and real vault contents; local observations do not establish attacker identity.",
    routes: ["/settings/security"],
    goal: "vaults.observation-receiver",
    keywords: ["canary", "detection", "receiver", "sealed evidence"],
  },
];
