import type { Capability } from "@opensesame/capability-registry";
import { CAPABILITY_TUTORIALS } from "./goals.js";
import { guideRouteWithin } from "./routes.js";

/** Context locality is distinct from where a cross-route walkthrough may start. */
const GOAL_CONTEXT_ROUTES = new Map(
  Object.entries({
    "vaults.switch": ["/vault", "/unlock", "/settings"],
    "host.health.check": [],
    "identity.account.add": ["/identity"],
    "access.sessions.review": ["/access"],
    "access.grant": ["/access"],
    "access.claim": ["/access"],
    "access.relay": ["/access"],
    "connection.create": ["/connections"],
    "connection.repair": ["/connections"],
    "vault.item.create": ["/vault"],
    "settings.secret-config": ["/settings/connectivity"],
    "settings.sync": ["/settings/connectivity"],
    "settings.model-provider": ["/settings/connectivity"],
    "settings.changelog": ["/settings"],
    "settings.backup": ["/settings/data"],
    "identity.sign-in": ["/unlock", "/identity"],
    "identity.sign-out": [],
    "identity.switch-account": [],
    "vault.second-step.code": ["/unlock", "/settings/security"],
    "vault.recovery-codes": ["/unlock", "/settings/security"],
    "identity.device.approve": ["/identity"],
    "vault.item-types.install": ["/settings"],
    "vault.export": ["/settings/data"],
    "client.support": [],
    "app.install": ["/settings"],
    "setup.first-run": ["/unlock", "/setup"],
    "setup.join-session": ["/unlock", "/setup"],
    "browser.pair": ["/connections", "/settings/connectivity"],
    "browser.authenticate": ["/connections", "/settings/connectivity"],
    "browser.revoke": ["/connections", "/settings/connectivity"],
    "configs.permissions": ["/settings/connectivity"],
    "agent.observe": ["/access"],
    "agent.control": ["/access"],
  }),
);

/** No truncation: every PWA capability must have an authored, reachable scope. */
export function capabilitiesForContext(
  capabilities: readonly Capability[],
  route: string,
  helpGoals: readonly string[],
): readonly Capability[] {
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
