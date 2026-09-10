import { type Database, agentInstances, agents } from "@opensesame/database";
import {
  type Agent,
  type AgentInstance,
  overlapCast,
} from "@opensesame/os-domain";
import { and, eq, inArray, sql } from "drizzle-orm";

const CAPACITY = 10_000;
function agentRow(row: typeof agents.$inferSelect): Agent {
  if (
    !row.ownerPrincipalId ||
    !["provisional", "claimed", "suspended", "revoked"].includes(row.state)
  )
    throw new Error("Invalid persisted agent");
  const value: Agent = {
    id: row.id,
    displayName: row.displayName,
    ownerPrincipalId: row.ownerPrincipalId,
    state: overlapCast(row.state),
    createdAt: row.createdAt,
  };
  if (row.projectId !== null) value.projectId = row.projectId;
  if (row.provider !== null) value.provider = row.provider;
  if (row.softwareIdentity !== null)
    value.softwareIdentity = row.softwareIdentity;
  return value;
}
function instanceRow(row: typeof agentInstances.$inferSelect): AgentInstance {
  const value: AgentInstance = {
    id: row.id,
    agentId: row.agentId,
    publicKeyJkt: row.publicKeyJkt,
    createdAt: row.createdAt,
  };
  if (row.clientId !== null) value.clientId = row.clientId;
  if (row.runtimeProvider !== null) value.runtimeProvider = row.runtimeProvider;
  if (row.attestationDigest !== null)
    value.attestationDigest = row.attestationDigest;
  if (row.expiresAt !== null) value.expiresAt = row.expiresAt;
  if (row.revokedAt !== null) value.revokedAt = row.revokedAt;
  return value;
}

/** The existing relational registry is authoritative, including the claim FKs. */
export class PostgresAgentStore {
  constructor(private readonly db: Database) {}
  async transaction<R>(
    work: (
      agents: PostgresAgentStore,
      instances: PostgresAgentInstanceStore,
    ) => Promise<R>,
  ): Promise<R> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:LegacyAgentRegistry'))`,
      );
      const db: Database = overlapCast(tx);
      return work(
        new PostgresAgentStore(db),
        new PostgresAgentInstanceStore(db),
      );
    });
  }
  async get(id: string): Promise<Agent | undefined> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    return row ? agentRow(row) : undefined;
  }
  async has(id: string) {
    return (await this.get(id)) !== undefined;
  }
  async countLive(principal: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::integer` })
      .from(agents)
      .where(
        and(
          eq(agents.ownerPrincipalId, principal),
          inArray(agents.state, ["provisional", "claimed", "suspended"]),
        ),
      );
    return row?.count ?? 0;
  }
  async listByOwner(principal: string): Promise<Agent[]> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(eq(agents.ownerPrincipalId, principal))
      .limit(CAPACITY + 1);
    if (rows.length > CAPACITY)
      throw new Error("Agent registry capacity exceeded");
    return rows.map(agentRow);
  }
  get size(): Promise<number> {
    return this.db
      .select({ count: sql<number>`count(*)::integer` })
      .from(agents)
      .then((rows) => rows[0]?.count ?? 0);
  }
  async values(): Promise<Agent[]> {
    const rows = await this.db
      .select()
      .from(agents)
      .limit(CAPACITY + 1);
    if (rows.length > CAPACITY)
      throw new Error("Agent registry capacity exceeded");
    return rows.map(agentRow);
  }
  async set(id: string, agent: Agent): Promise<this> {
    if (id !== agent.id) throw new Error("Agent identity mismatch");
    await this.transaction(async (store) => {
      if (!(await store.has(id)) && (await store.size) >= CAPACITY)
        throw new Error("Agent registry capacity exceeded");
      await store.db
        .insert(agents)
        .values(agent)
        .onConflictDoUpdate({ target: agents.id, set: agent });
    });
    return this;
  }
  async delete(id: string): Promise<boolean> {
    return this.transaction(async (store) => {
      const rows = await store.db
        .delete(agents)
        .where(eq(agents.id, id))
        .returning({ id: agents.id });
      return rows.length === 1;
    });
  }
  async claim(id: string, principal: string): Promise<void> {
    await this.transaction(async (store) => {
      const agent = await store.get(id);
      if (
        agent?.state === "provisional" &&
        agent.ownerPrincipalId === principal
      )
        await store.set(id, { ...agent, state: "claimed" });
    });
  }
}

export class PostgresAgentInstanceStore {
  constructor(private readonly db: Database) {}
  async get(id: string): Promise<AgentInstance | undefined> {
    const [row] = await this.db
      .select()
      .from(agentInstances)
      .where(eq(agentInstances.id, id))
      .limit(1);
    return row ? instanceRow(row) : undefined;
  }
  async has(id: string) {
    return (await this.get(id)) !== undefined;
  }
  get size(): Promise<number> {
    return this.db
      .select({ count: sql<number>`count(*)::integer` })
      .from(agentInstances)
      .then((rows) => rows[0]?.count ?? 0);
  }
  async set(id: string, instance: AgentInstance): Promise<this> {
    if (id !== instance.id) throw new Error("Agent instance identity mismatch");
    await new PostgresAgentStore(this.db).transaction(
      async (_agents, store) => {
        if (!(await store.has(id)) && (await store.size) >= CAPACITY)
          throw new Error("Agent instance capacity exceeded");
        await store.db
          .insert(agentInstances)
          .values(instance)
          .onConflictDoUpdate({ target: agentInstances.id, set: instance });
      },
    );
    return this;
  }
  async delete(id: string): Promise<boolean> {
    return new PostgresAgentStore(this.db).transaction(
      async (_agents, store) => {
        const rows = await store.db
          .delete(agentInstances)
          .where(eq(agentInstances.id, id))
          .returning({ id: agentInstances.id });
        return rows.length === 1;
      },
    );
  }
}
