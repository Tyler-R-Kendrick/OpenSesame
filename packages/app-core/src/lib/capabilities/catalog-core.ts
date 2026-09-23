/**
 * Core-tier descriptors: always present in every distribution and plan
 * (ownership.md §5). They are listed so their exposure is declared and a
 * consent receipt can bind it, never so they can be switched off.
 *
 * Operation ids come from `@opensesame/capability-registry`'s
 * `OPERATION_CAPABILITY` map; the catalog test asserts the two agree.
 */

import { type AuthoredDescriptor, core } from "./descriptor.js";

export const CORE_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  core(
    "shell.navigation",
    "Shell and navigation",
    "The rail, routes, crumbs, command bar, keymap and statusline every other capability contributes into.",
    {
      operationIds: ["app.navigate", "app.status", "client.command_bar"],
    },
  ),
  core(
    "vault.passwords",
    "Vault items",
    "Logins, notes, cards and secrets: the item list, editor, TOTP codes, website matching and the health report.",
    {
      operationIds: [
        "vault.item_types.install",
        "vault.item_types.list",
        "vault.items.read_meta",
        "vault.items.reveal",
        "vault.items.search",
        "vault.items.write_meta",
        "vault.login_draft",
        "vault.totp.code",
      ],
      // Untrusted website-pattern regexes run in a disposable worker.
      environments: ["document", "dedicated-worker"],
      browserPermissions: ["clipboard-write"],
      keyAccess: "item-plaintext",
      itemKinds: ["login", "note", "card", "secret"],
    },
  ),
  core(
    "vault.local-unlock",
    "Local unlock",
    "Password, PIN and passkey protectors for the vault key, the enrolled second step, recovery codes and the device's vault list.",
    {
      operationIds: [
        "vault.recovery_codes",
        "vault.second_step.code",
        "vaults.switch",
      ],
      egress: [
        {
          class: "external-service",
          purpose:
            "the configured Identity API, only to send an emailed or texted second-step code",
          automatic: false,
        },
      ],
      browserPermissions: ["webauthn"],
      keyAccess: "protector-wrap",
      offlineLimits:
        "Emailed and texted second-step codes need the Identity API; every local protector works offline.",
    },
  ),
  core(
    "backup.local-encrypted",
    "Encrypted local backup",
    "Export the vault as one encrypted file, import it back, and recover from it on a new device.",
    {
      operationIds: ["vault.export"],
      keyAccess: "protector-wrap",
    },
  ),
  core(
    "identity.brokered-signin",
    "Sign-in and guest",
    "The front door: the compiled-in broker road, continue as guest, seal a local vault, and sign out or switch account.",
    {
      operationIds: [
        "identity.login",
        "identity.signout",
        "identity.switch_account",
        "identity.whoami",
      ],
      egress: [
        {
          class: "external-service",
          purpose:
            "the compiled-in sign-in broker and, when one is configured, the Identity API",
          automatic: false,
        },
        {
          class: "user-mediated-navigation",
          purpose: "the OpenID redirect a person starts by pressing a provider",
          automatic: false,
        },
      ],
      browserPermissions: ["webauthn"],
      // A sign-in PRF assertion may wrap the vault key (#451).
      keyAccess: "protector-wrap",
      offlineLimits:
        "Guest and a local-only seal work offline; a brokered sign-in needs the broker.",
    },
  ),
  core(
    "settings.core",
    "Settings",
    "General, Security, Vaults, Danger and Capabilities, the deployment setup record and the runtime endpoint file.",
    {
      operationIds: ["setup.first_run"],
      egress: [
        {
          class: "application-assets",
          purpose:
            "os-runtime-config.json beside the bundle, read once at boot",
          automatic: true,
        },
      ],
    },
  ),
  core(
    "install.pwa",
    "Install offer",
    "The install card and mark, persistent storage, update checks and the core-only service worker that keeps the shell offline.",
    {
      operationIds: ["app.install", "pwa.status"],
      environments: ["document", "service-worker"],
      egress: [
        {
          class: "application-assets",
          purpose: "the shell and approved asset plan the worker caches",
          automatic: true,
        },
      ],
      browserPermissions: ["persistent-storage"],
    },
  ),
];
