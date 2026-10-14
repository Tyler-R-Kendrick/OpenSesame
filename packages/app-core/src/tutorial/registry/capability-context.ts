/**
 * The fields the support context reads. A full registry `Capability` has
 * them; so does the page-reachable projection Pages ships
 * (`@opensesame/capability-registry/pwa-summaries.json`).
 */
export type ContextCapability = {
  id: string;
  title: string;
  plane: string;
  surfaces: { pwa: string | null };
};
import { CAPABILITY_TUTORIALS } from "./goals.js";
import { guideRouteWithin } from "./routes.js";

/** Context locality is distinct from where a cross-route walkthrough may start. */
const GOAL_CONTEXT_ROUTES = new Map(
  Object.entries({
    "vaults.switch": ["/vault", "/unlock", "/settings"],
    "vaults.duress-code": ["/settings/security"],
    "vaults.travel": ["/settings/security"],
    "settings.security.review": ["/settings/security"],
    "settings.danger.review": ["/settings/danger"],
    "host.health.check": [],
    "identity.account.add": ["/identity"],
    "identity.users.manage": ["/identity"],
    "identity.local.directory.manage": ["/identity"],
    "identity.local.access.manage": ["/access"],
    "identity.local.policy.manage": ["/access"],
    "identity.local.requests.manage": ["/access"],
    "identity.local.passkeys.manage": ["/identity"],
    "identity.local.organizations.member": ["/identity"],
    "identity.local.agent.keys.manage": ["/identity"],
    "identity.local.application.authorize": [
      "/identity",
      "/identity/authorize",
    ],
    "identity.agents.manage": ["/identity"],
    "access.sessions.review": ["/access"],
    "access.grant": ["/access"],
    "access.relay": ["/access"],
    "connection.create": ["/connections"],
    "connection.repair": ["/connections"],
    "vault.item.create": ["/vault"],
    "vault.item.edit": ["/vault/item"],
    "vault.health.review": ["/vault/health"],
    "settings.model-provider": ["/settings/features"],
    "settings.tailnet-sync": ["/settings/vaults"],
    "settings.notifications": ["/settings/notifications"],
    "settings.local-notifications": ["/settings/features"],
    "settings.backup": ["/settings/integrations"],
    "feature.certificates": ["/settings/features"],
    "settings.surrogate-credentials": ["/settings/features"],
    "settings.browser-autofill": ["/settings/features"],
    "identity.sign-in": ["/identity"],
    "identity.sign-out": [],
    "identity.switch-account": [],
    "vault.second-step.code": ["/unlock", "/settings/security"],
    "vault.recovery-codes": ["/unlock", "/settings/security"],
    "identity.account-factors": ["/settings/security"],
    "identity.device.approve": ["/identity"],
    "identity.claim.accept": ["/identity"],
    "identity.drop.open": ["/identity"],
    "identity.interaction.approve": ["/identity"],
    "identity.approval.review": ["/access"],
    "vault.item-types.install": ["/settings"],
    "vault.export": ["/vault"],
    "vault.import": ["/vault"],
    "vault.environments": ["/vault"],
    "client.support": [],
    "client.command-bar": [],
    "app.install": ["/settings"],
    "feature.identity": ["/settings/features"],
    "feature.sharing": ["/settings/features"],
    "feature.password-reset": ["/settings/features"],
    "feature.security-checks": ["/settings/features", "/settings/vaults"],
    "access.connectors": ["/access"],
    "browser.pair": ["/connections", "/settings/features"],
    "browser.authenticate": ["/connections", "/settings/features"],
    "agent.observe": ["/access"],
    "agent.control": ["/access"],
    "authority.portal.templates.manage": ["/access"],
    "authority.portal.templates.read": ["/access"],
    "identity.local.siop.authorize": ["/identity"],
    "identity.tailnet.devices.manage": ["/identity"],
    "settings.trusted-contacts.circle": ["/settings/trusted-contacts"],
  }),
);

/** No truncation: every PWA capability must have an authored, reachable scope. */
export function capabilitiesForContext<T extends ContextCapability>(
  capabilities: readonly T[],
  route: string,
  helpGoals: readonly string[],
): readonly T[] {
  const tutorials: Readonly<Record<string, string>> = CAPABILITY_TUTORIALS;
  return capabilities.filter((capability) => {
    if (capability.surfaces.pwa === null) return false;
    const goal = tutorials[capability.id];
    const routes = goal ? GOAL_CONTEXT_ROUTES.get(goal) : undefined;
    if (!routes)
      throw new Error(`support_capability_scope_missing:${capability.id}`);
    return (
      routes.length === 0 ||
      helpGoals.includes(goal ?? "") ||
      routes.some((scope) => guideRouteWithin(route, scope))
    );
  });
}
