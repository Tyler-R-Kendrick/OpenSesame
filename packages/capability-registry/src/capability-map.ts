/**
 * Operation → product capability (capability composition, ownership.md §2).
 *
 * Two identifier universes meet here and stay distinct: the keys are the
 * registry's *operation* ids (unchanged, ADR 0065), the values are the Pages
 * *product capability* ids a person selects (`packages/app-core/src/lib/
 * capabilities/catalog.ts`). Every registry entry carrying a `pwa` or `webmcp` surface is
 * owned by exactly one product capability; the registry test enforces
 * completeness and the Pages catalog test enforces that the catalog's
 * `operationIds` are exactly this map grouped by value.
 *
 * Core capabilities (always present) own the operations that must work on an
 * empty device: the shell, the vault, unlock, the front door, settings, the
 * install offer. Everything else is optional and default off.
 */

export const OPERATION_CAPABILITY: Readonly<Record<string, string>> =
  Object.freeze({
    // --- core: shell -----------------------------------------------------
    "app.status": "shell.navigation",
    "app.navigate": "shell.navigation",
    "client.command_bar": "shell.navigation",

    // --- core: vault items -----------------------------------------------
    "vault.items.search": "vault.passwords",
    "vault.items.read_meta": "vault.passwords",
    "vault.items.write_meta": "vault.passwords",
    "vault.items.reveal": "vault.passwords",
    "vault.totp.code": "vault.passwords",
    "vault.login_draft": "vault.passwords",
    "vault.item_types.list": "vault.passwords",
    "vault.item_types.install": "vault.passwords",
    "vault.item_types.marketplace": "vault.passwords",

    // --- core: unlock and vaults ----------------------------------------
    "vaults.switch": "vault.local-unlock",
    "vaults.travel": "vault.local-unlock",
    "vault.second_step.code": "vault.local-unlock",
    "vault.recovery_codes": "vault.local-unlock",

    // --- core: encrypted backup -----------------------------------------
    "vault.export": "backup.local-encrypted",

    // --- core: front door / identity session ----------------------------
    "identity.login": "identity.brokered-signin",
    "identity.signout": "identity.brokered-signin",
    "identity.switch_account": "identity.brokered-signin",
    "identity.whoami": "identity.brokered-signin",

    // --- always-on: ceremonies a link opens (ADR 0140) --------------------
    "identity.device.approve": "identity.ceremonies",
    "identity.claim.accept": "identity.ceremonies",
    "identity.drop.open": "identity.ceremonies",

    // --- core: settings and install -------------------------------------
    "setup.first_run": "settings.core",
    "app.install": "install.pwa",

    // --- optional: access authority (local PAM + Host plane) -------------
    "authority.portal.templates.manage": "access.authority",
    "authority.portal.templates.read": "access.authority",
    "receipts.read": "access.authority",
    // Transport security is deployment-plane operator work (ADR 0132): the
    // Pages surface only reads status and capability, references a
    // registered identity by name and runs the enforcement probe.
    "transport.status.view": "access.authority",
    "transport.verify.run": "access.authority",
    "transport.identity.reference": "access.authority",
    "transport.capabilities.discover": "access.authority",
    "delegations.claim": "access.authority",
    "shared_sessions.join_request": "access.authority",
    "agent_identities.read": "access.authority",
    "identity.local.requests.manage": "access.authority",
    "identity.local.policy.manage": "access.authority",
    "identity.local.access.manage": "access.authority",
    "host.health.pages": "access.authority",
    "host.whoami": "access.authority",
    "browser.pairing.begin": "access.authority",
    "browser.identity.authenticate": "access.authority",
    "browser.grant.renew": "access.authority",
    "browser.client.revoke": "access.authority",
    "configs.browse": "access.authority",
    "configs.set": "access.authority",
    "configs.permissions.read": "access.authority",
    "changelog.read": "access.authority",

    // --- optional: external connectors ----------------------------------
    "providers.list": "connectors.external",
    "connections.list": "connectors.external",
    "connections.inspect": "connectors.external",
    "connections.create": "connectors.external",
    "connections.credential.set": "connectors.external",
    "connections.bindings": "connectors.external",
    "connections.remove": "connectors.external",
    "integrations.read": "connectors.external",
    "connectors.directory.sync": "connectors.external",
    "connectors.bind": "connectors.external",
    "connectors.connect.configure": "connectors.external",
    "connectors.connect.authorize_user": "connectors.external",
    "connectors.connect.token_check": "connectors.external",

    // --- optional: git remote backup ------------------------------------
    "backup.status": "backup.git-remote",
    "backup.target.set": "backup.git-remote",
    "sync_targets.read": "backup.git-remote",
    "sync_targets.trigger": "backup.git-remote",

    // --- optional: tailnet networking -----------------------------------
    "vault.drive.sync": "networking.tailnet",

    // --- optional: browser-local IAM ------------------------------------
    "identity.local.agent.keys.manage": "identity.local-iam",
    "identity.local.application.authorize": "identity.local-iam",
    "identity.local.passkeys.manage": "identity.local-iam",
    "identity.local.directory.manage": "identity.local-iam",
    "identity.local.siop.authorize": "identity.siop",

    // --- optional: enterprise -------------------------------------------
    "identity.admin": "enterprise.directory-provisioning",
    "identity.agent.register": "enterprise.directory-provisioning",
    "identity.agent.manage": "enterprise.directory-provisioning",
    "identity.users.manage": "enterprise.directory-provisioning",
    "certs.issue": "enterprise.ca-administration",

    // --- optional: support ----------------------------------------------
    "client.support": "support.guided-help",
    "client.tutorial": "support.guided-help",
    "model_plane.read": "support.local-ai",
    "model_plane.choose": "support.local-ai",

    // --- optional: wallet -----------------------------------------------
    "wallet.capabilities.read": "wallet.spending",
    "wallet.budgets.read": "wallet.spending",
    "wallet.allocations.read": "wallet.spending",
    "wallet.payment.propose": "wallet.spending",
    "wallet.payment.execute_approved": "wallet.spending",
    "wallet.payment.status": "wallet.spending",
    "wallet.lease.request": "wallet.spending",
    "wallet.lease.status": "wallet.spending",
    "wallet.lease.request_stop": "wallet.spending",
  });

/**
 * Operation ids owned by any of the given product capabilities, sorted.
 * Unknown capability ids contribute nothing; the result never widens.
 */
export function operationsForCapabilities(ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return Object.entries(OPERATION_CAPABILITY)
    .filter(([, capability]) => wanted.has(capability))
    .map(([operation]) => operation)
    .sort();
}

/** Product capability ids that own at least one operation, sorted. */
export function capabilitiesWithOperations(): string[] {
  return [...new Set(Object.values(OPERATION_CAPABILITY))].sort();
}
