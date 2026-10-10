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
    "password_provider.read": "vault.passwords",
    "password_provider.env_resolve": "vault.passwords",
    "vault.workflow.find_references": "vault.passwords",
    "vault.workflow.inventory": "vault.passwords",
    "vault.workflow.audit_organization": "vault.passwords",
    "vault.workflow.env_template": "vault.passwords",
    "vault.workflow.create_private": "vault.passwords",
    "vault.workflow.compare_private": "vault.passwords",
    "vault.workflow.update_private": "vault.passwords",
    "vault.item.create": "vault.passwords",
    "vault.item.set": "vault.passwords",
    "vault.item.share": "vault.passwords",
    "vault.account.pepper": "vault.passwords",
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
    "vaults.travel_items": "vault.local-unlock",
    "vaults.duress_code": "vault.local-unlock",
    "cli.app_integration.list": "cli.app-integration",
    "cli.app_integration.respond": "cli.app-integration",
    "vault.second_step.code": "vault.local-unlock",
    "vault.recovery_codes": "vault.local-unlock",
    "vault.protectors.manage": "vault.local-unlock",
    "vault.protectors.rotate": "vault.local-unlock",
    "device.browser_reset": "vault.local-unlock",

    // --- core: encrypted backup -----------------------------------------
    "vault.export": "backup.local-encrypted",

    // --- always-on: other managers' formats (the vault's Import key) -----
    "vault.import": "vault.interop-formats",
    // The sealed-store bridge's path manifest (ADR 0037 §6).
    "vault.store_manifest.import": "vault.interop-formats",

    // --- core: front door / identity session ----------------------------
    "identity.login": "identity.brokered-signin",
    "identity.signout": "identity.brokered-signin",
    "identity.switch_account": "identity.brokered-signin",
    "identity.whoami": "identity.brokered-signin",

    // --- always-on: the Identity account's own factors (ADR 0140 D10) ----
    // Settings › Security rows beside the vault's keys.
    "identity.account_factors.list": "identity.federation",
    "identity.account_factors.enroll": "identity.federation",
    "identity.account_factors.remove": "identity.federation",

    // --- always-on: ceremonies a link opens (ADR 0140) --------------------
    "identity.device.approve": "identity.ceremonies",
    "identity.claim.accept": "identity.ceremonies",
    "identity.drop.open": "identity.ceremonies",
    // `/i/:ref` and `/approve/:ref` (ADR 0140 plan step 9, D7).
    "identity.interaction.approve": "identity.ceremonies",
    "identity.interaction.deny": "identity.ceremonies",
    "identity.approval.activation": "identity.ceremonies",
    "identity.approval.comparison": "identity.ceremonies",
    "identity.approval.report": "identity.ceremonies",
    // `/invoke/:kind`, the authenticator hand-off (plan step 10).
    "identity.authenticator.invoke": "identity.ceremonies",

    // --- core: settings and install -------------------------------------
    "setup.first_run": "settings.core",
    "app.install": "install.pwa",

    // --- optional: access authority (local PAM + Host plane) -------------
    "authority.portal.templates.manage": "access.authority",
    "authority.portal.templates.read": "access.authority",
    "receipts.read": "access.authority",
    "delegations.claim": "access.authority",
    "shared_sessions.join_request": "access.authority",
    "agent_identities.read": "access.authority",
    "identity.local.requests.manage": "access.authority",
    // Access › Sessions' receipts: the device's own trail (ADR 0162).
    "identity.local.receipts.read": "access.authority",
    // Access › Requests' hosted rows; each opens `/approve/:ref`.
    "identity.approval.requests": "access.authority",
    "identity.local.policy.manage": "access.authority",
    "identity.local.access.manage": "access.authority",
    "host.health.pages": "access.authority",
    "host.whoami": "access.authority",
    "browser.pairing.begin": "access.authority",
    "browser.identity.authenticate": "access.authority",
    "browser.grant.renew": "access.authority",

    // --- optional: external connectors ----------------------------------
    "providers.list": "connectors.external",
    "connections.list": "connectors.external",
    "connections.inspect": "connectors.external",
    "connections.create": "connectors.external",
    "connections.credential.set": "connectors.external",
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

    // --- optional: local notifications (ADR 0162) ------------------------
    // Where this device tells its person a request is waiting, with no
    // service in the picture.
    "identity.notification.local.manage": "notifications.local",

    // --- optional: notification routing (ADR 0084, ADR 0140 D9) ---------
    // Settings › Notifications: where the Identity API tells a person about
    // requests. Where they are told never changes what it takes to approve.
    "identity.notification.channels.read": "notifications.routing",
    "identity.notification.bindings.manage": "notifications.routing",
    "identity.notification.preferences.manage": "notifications.routing",

    // --- optional: breach and two-step checks (ADR 0080 §5) ------------
    "vault.health.security_check": "vault.security-checks",

    // --- optional: tailnet networking -----------------------------------
    "vault.drive.sync": "networking.tailnet",
    // The daemon the plugin tiles reach is paired through the tailnet
    // capability both plugin capabilities depend on (ADR 0150 §7).
    "plugins.pair": "networking.tailnet",
    "plugins.unpair": "networking.tailnet",

    // --- optional: tailnet device management (ADR 0169) -----------------
    // The tailnet's machines, managed through the paired daemon, which
    // holds the Tailscale credential.
    "tailnet.devices.pair": "networking.tailnet-devices",
    "tailnet.devices.read": "networking.tailnet-devices",
    "tailnet.devices.manage": "networking.tailnet-devices",
    "tailnet.keys.manage": "networking.tailnet-devices",
    "tailnet.audit.read": "networking.tailnet-devices",

    // --- optional: runtime-installed plugins (ADR 0150 §7) ---------------
    "plugins.surrogate_proxy.switch": "agents.surrogate-credentials",
    "plugins.surrogate_proxy.tripwires": "agents.surrogate-credentials",
    "plugins.browser_autofill.switch": "vault.browser-autofill",

    // --- optional: live sessions (ADR 0150) -----------------------------
    "shared_sessions.live_host": "sharing.live",
    "shared_sessions.live_join": "sharing.live",

    // --- optional: browser-local IAM ------------------------------------
    "identity.local.agent.keys.manage": "identity.local-iam",
    "identity.local.application.authorize": "identity.local-iam",
    "identity.local.passkeys.manage": "identity.local-iam",
    "identity.local.directory.manage": "identity.local-iam",
    "identity.local.organizations.read": "identity.local-iam",
    "identity.local.organizations.membership.manage": "identity.local-iam",
    "identity.local.siop.authorize": "identity.siop",

    // --- optional: enterprise -------------------------------------------
    "identity.admin": "enterprise.directory-provisioning",
    "identity.agent.register": "enterprise.directory-provisioning",
    "identity.agent.manage": "enterprise.directory-provisioning",
    "identity.users.manage": "enterprise.directory-provisioning",
    // Identity › Organizations' sign-in panels (ADR 0140 plan step 12).
    "identity.org_signin.upstream.manage": "enterprise.directory-provisioning",
    "identity.org_signin.domains.manage": "enterprise.directory-provisioning",
    "identity.org_signin.scim_tokens.manage":
      "enterprise.directory-provisioning",
    "identity.org_signin.scim_token.mint": "enterprise.directory-provisioning",
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
