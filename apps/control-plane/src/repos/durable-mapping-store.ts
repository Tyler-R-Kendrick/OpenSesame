import type {
  PrincipalMapping,
  PrincipalMappingStore,
} from "@opensesame/auth-upstream";
import type { Database } from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import { DurableMap } from "./durable-map.js";

export class DurablePrincipalMappingStore implements PrincipalMappingStore {
  private readonly mappings: DurableMap<PrincipalMapping>;
  private readonly indexes: DurableMap<string>;
  constructor(private readonly db: Database) {
    this.mappings = new DurableMap(
      db,
      "OpenSesame:PrincipalMapping",
      false,
      null,
    );
    this.indexes = new DurableMap(
      db,
      "OpenSesame:PrincipalMappingIndex",
      false,
      null,
    );
  }
  findByPrincipalId(id: string) {
    return this.mappings.get(id);
  }
  private async find(key: string) {
    const id = await this.indexes.get(key);
    return id ? this.mappings.get(id) : undefined;
  }
  findByBetterAuthUserId(id: string) {
    return this.find(JSON.stringify(["better_auth", id]));
  }
  findByUpstream(issuer: string, subject: string) {
    return this.find(JSON.stringify(["upstream", issuer, subject]));
  }
  findByEmail(email: string) {
    return this.find(JSON.stringify(["email", email.toLowerCase()]));
  }
  async save(mapping: PrincipalMapping): Promise<PrincipalMapping> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:PrincipalMapping'), hashtext(${mapping.principalId}))`,
      );
      const store = new DurablePrincipalMappingStore(overlapCast(tx));
      const keys = [JSON.stringify(["better_auth", mapping.betterAuthUserId])];
      if (mapping.upstreamProviderId && mapping.upstreamSubject)
        keys.push(
          JSON.stringify([
            "upstream",
            mapping.upstreamProviderId,
            mapping.upstreamSubject,
          ]),
        );
      for (const key of keys) {
        const claimed = await store.indexes.claim(key, mapping.principalId);
        if (!claimed && (await store.indexes.get(key)) !== mapping.principalId)
          throw new Error("Identity already linked to another principal");
      }
      await store.mappings.set(mapping.principalId, mapping);
      if (mapping.email)
        await store.indexes.set(
          JSON.stringify(["email", mapping.email.toLowerCase()]),
          mapping.principalId,
        );
    });
    return mapping;
  }
  async deleteProvisional(principalId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:PrincipalMapping'), hashtext(${principalId}))`,
      );
      const store = new DurablePrincipalMappingStore(overlapCast(tx));
      const mapping = await store.findByPrincipalId(principalId);
      if (!mapping?.provisional) return false;
      await store.mappings.delete(principalId);
      await store.indexes.delete(
        JSON.stringify(["better_auth", mapping.betterAuthUserId]),
      );
      return true;
    });
  }
}
