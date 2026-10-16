/**
 * One tutorial per integration: what a section of Settings › Integrations
 * lists, and what connecting one of its providers does and does not send.
 *
 * An integration is a third party a feature connects to, configured by
 * reference on the connector's own page, so every tour here is the same walk:
 * it navigates to the page, points at the section heading, and says in a
 * closing step what a connection holds. None of them depends on the feature
 * it extends being on. The sections that already have a task-shaped tour —
 * Backups and AI — are not repeated here; `INTEGRATION_TUTORIALS` below says
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
    id: "integration.local-storage",
    title: "Connect a local store",
    routes: ["/settings"],
    libraryOnly: true,
    guide: [
      "guide/1",
      'goal "integration.local-storage"',
      'say "Local storage lists the stores that live on this device or next to it — KeePass, the system keychain, a password-store directory and the sealed local store."',
      'navigate "/settings/integrations"',
      'wait route "/settings/integrations" timeout=15000',
      'scroll "integration.local-storage"',
      'focus "integration.local-storage" "The Local storage section. Each tile opens that store\'s page." side=bottom',
      'say "A local store is read on this device. Nothing about it is sent to a provider."',
      'success "That is Local storage."',
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
  "local-storage": "integration.local-storage",
  payments: "integration.payments",
  ai: "settings.model-provider",
  networking: "integration.networking",
} as const satisfies Readonly<Record<IntegrationId, string>>;
