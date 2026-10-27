/**
 * One tutorial per integration: what a section of Settings › Integrations
 * lists, and what connecting one of its providers does and does not send.
 *
 * An integration is a third party a feature connects to, configured by
 * reference on the connector's own page, so every tour here is the same walk:
 * it navigates to the page, points at the section heading, and says in a
 * closing step what a connection holds. None of them depends on the feature
 * it extends being on. The sections that already have a task-shaped tour —
 * Backups — are not repeated here; `INTEGRATION_TUTORIALS` below says
 * which tutorial an integration opens. The switches are Settings › Features,
 * and `feature-goals.ts` tours those.
 *
 * Authored, checked-in prose; compiled by the same parser and validator model
 * output goes through (ADR 0088).
 */

import type { IntegrationId } from "../../lib/capabilities/integrations.js";
import type { GuideGoalDescriptor } from "./goals.js";

export const INTEGRATION_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "integration.services",
    title: "Connect a service",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.services"',
      'say "Services groups developer APIs, productivity, communication, storage and CRM connections."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.services"',
      'focus "integration.services" "Each tile opens the service configuration page. Choose its documented authentication method and permissions there." side=bottom',
      'say "Opening this list does not authorize provider access. The connection uses its approved route when you authorize or request a provider operation."',
      'success "That is Services."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.identity",
    title: "Connect an identity provider",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.identity"',
      'say "Browser-local identity needs no service. An identity provider is what you connect beside it when people should sign in through an account that lives elsewhere."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.identity"',
      'focus "integration.identity" "The Identity section. Each tile opens a provider\'s page — Clerk, Better Auth, WorkOS or Auth0 — where it is connected by reference." side=bottom',
      'say "A connection\'s credential is sealed in the vault. Nothing is sent to a provider until you connect it."',
      'success "That is Identity providers."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.encryption",
    title: "Choose where keys can live",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.encryption"',
      'say "A vault is sealed by keys that open it. The Encryption section lists the key services this installation can reference — a cloud key service, a hardware key, an age recipient — and the browser\'s own WebCrypto, which needs nothing."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.encryption"',
      'focus "integration.encryption" "The Encryption section. Each tile opens that provider\'s page, where it is configured by reference." side=bottom',
      'say "A cloud key service holds a credential, and that credential is sealed in the vault, never kept in the clear. Nothing is sent to a provider until you connect it."',
      'success "That is Encryption."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.certificates",
    title: "Connect a certificate authority",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.certificates"',
      'say "Certificate authority lists the authorities this installation can connect to — Let\'s Encrypt, ZeroSSL and Cloudflare Origin CA."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.certificates"',
      'focus "integration.certificates" "The Certificate authority section. Each tile opens that authority\'s page, where it is connected by reference." side=bottom',
      'say "Nothing is sent to an authority until you connect it. Certificates themselves are vault items, added from the vault."',
      'success "That is the certificate authority."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.password-managers",
    title: "Connect a password manager",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.password-managers"',
      'say "Password managers lists the ones this installation can connect to — 1Password, Bitwarden, Proton Pass, Passbolt and others — so the tools you already use keep working beside the vault."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.password-managers"',
      'focus "integration.password-managers" "The Password managers section. Each tile opens that manager\'s page." side=bottom',
      'say "A connection is by reference. Nothing from another manager is read until you connect it, and an agent never reads a value out of one."',
      'success "That is Password managers."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.cloud-secret-storage",
    title: "Connect a cloud secret store",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.cloud-secret-storage"',
      'say "Cloud secret storage lists the stores this installation can connect to — AWS, Azure, Google Cloud, Doppler, Vault, OpenBao and others."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.cloud-secret-storage"',
      'focus "integration.cloud-secret-storage" "The Cloud secret storage section. Each tile opens that store\'s page." side=bottom',
      'say "A connection is by reference, and the credential behind it is sealed in the vault. Nothing is sent to a store until you connect it."',
      'success "That is Cloud secret storage."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.payments",
    title: "Connect a payment provider",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.payments"',
      'say "The Wallet\'s budgets and passes can work with providers you connect — wallet passes and card issuers. An agent is given a budget; it is never given a card number."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.payments"',
      'focus "integration.payments" "The Payments section. Each tile opens a provider\'s page, where it is connected by reference." side=bottom',
      'say "Nothing is sent to a provider until you connect it, and its credential is sealed in the vault."',
      'success "That is Payment providers."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.password-reset",
    title: "Connect a password-reset runtime",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.password-reset"',
      'say "Password reset can use a computer-use runtime you configure. Its model provider is connected separately in AI."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.password-reset"',
      'focus "integration.password-reset" "Choose Vercel Sandbox, E2B or Browserbase CDP here. Each runtime opens its own configuration page." side=bottom',
      'say "Opening this list contacts nothing. Runtime configuration and every reset require your approval."',
      'success "That is Password reset runtimes."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.ai",
    title: "Connect an AI provider",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.ai"',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.ai"',
      'focus "integration.ai" "Connect an agent harness or AI model provider here. Voice and inference model choices are in Settings › Features › AI." side=bottom',
      'say "A provider connection holds its configuration and a credential sealed in this vault. Nothing is sent until you connect it."',
      'success "That is AI providers."',
      "end",
    ].join("\n"),
  },
  {
    id: "integration.networking",
    title: "Connect a tailnet provider",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.networking"',
      'say "Networking reaches your other devices through a tailnet. The provider that runs it is connected here, by reference."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.networking"',
      'focus "integration.networking" "The Networking section. The tile opens the provider\'s page, where it is connected." side=bottom',
      'say "Nothing is sent to a provider until you connect it, and its credential is sealed in the vault."',
      'success "That is Networking."',
      "end",
    ].join("\n"),
  },
];

/**
 * The tutorial each section of Settings › Integrations opens: its own tour
 * above, or the task-shaped tour that already covers it.
 */
export const INTEGRATION_TUTORIALS = {
  identity: "integration.identity",
  encryption: "integration.encryption",
  certificates: "integration.certificates",
  backups: "settings.backup",
  "password-managers": "integration.password-managers",
  "cloud-secret-storage": "integration.cloud-secret-storage",
  payments: "integration.payments",
  "password-reset": "integration.password-reset",
  ai: "integration.ai",
  networking: "integration.networking",
  services: "integration.services",
} as const satisfies Readonly<Record<IntegrationId, string>>;
