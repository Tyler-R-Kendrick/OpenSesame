import type { Agent, AgentInstance } from "@opensesame/os-domain";
import { serializeKeyed } from "../serialize.js";
import { type AppStores, getAgentUsage } from "../state.js";
import { PostgresAgentStore } from "./legacy-agent-postgres.js";

type Registry = Pick<AppStores, "agents" | "agentInstances">;

export function transaction<R>(
  stores: AppStores,
  principal: string,
  work: (registry: Registry) => Promise<R>,
) {
  if (stores.agents instanceof PostgresAgentStore) {
    return stores.agents.transaction((agents, agentInstances) =>
      work({ agents, agentInstances }),
    );
  }
  return serializeKeyed(stores.principalMutations, principal, () =>
    work(stores),
  );
}

export async function claimLegacyAgent(
  stores: AppStores,
  id: string,
  principal: string,
): Promise<void> {
  if (stores.agents instanceof PostgresAgentStore)
    return stores.agents.claim(id, principal);
  const agent = stores.agents.get(id);
  if (agent?.state === "provisional" && agent.ownerPrincipalId === principal)
    stores.agents.set(id, { ...agent, state: "claimed" });
}

/** Reserve quota and both records before issuing any claim; replicas share one lock. */
export function reserveLegacyAgent(
  stores: AppStores,
  agent: Agent,
  instance: AgentInstance,
  allowed: (count: number) => boolean,
): Promise<boolean> {
  return transaction(stores, agent.ownerPrincipalId, async (registry) => {
    if (!allowed(await getAgentUsage(registry, agent.ownerPrincipalId)))
      return false;
    if (
      (await registry.agents.has(agent.id)) ||
      (await registry.agentInstances.has(instance.id))
    )
      throw new Error("Agent registration collision");
    await registry.agents.set(agent.id, agent);
    await registry.agentInstances.set(instance.id, instance);
    return true;
  });
}

/** A failed claim issuance removes only the exact reservation it created. */
export function releaseLegacyAgent(
  stores: AppStores,
  agent: Agent,
  instance: AgentInstance,
): Promise<void> {
  return transaction(stores, agent.ownerPrincipalId, async (registry) => {
    const current = await registry.agents.get(agent.id);
    const child = await registry.agentInstances.get(instance.id);
    if (
      current?.ownerPrincipalId !== agent.ownerPrincipalId ||
      current.state !== "provisional" ||
      child?.agentId !== agent.id
    )
      return;
    await registry.agentInstances.delete(instance.id);
    await registry.agents.delete(agent.id);
  });
}
