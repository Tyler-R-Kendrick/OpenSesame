import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import {
  type Database,
  type EventSealer,
  internalSecurityPrincipal,
  oidcLookup,
  oidcPayloads,
  openOidcRow,
  sealOidcRow,
} from "@opensesame/database";
import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

/** Internal server-owned records only; never deserialize client-supplied bytes. */
export class DurableMap<T> {
  private readonly sealer: EventSealer;
  constructor(
    private readonly db: Database,
    private readonly model: string,
    private readonly secretKeys = false,
    private readonly ttlMs: number | null = 86_400_000,
    private readonly capacity = 10_000,
    sealer?: EventSealer,
  ) {
    if (!sealer)
      throw new Error("A durable sealing key is required for security state");
    this.sealer = sealer;
    if (!model.startsWith("OpenSesame:"))
      throw new Error("Invalid internal state namespace");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000)
      throw new Error("Invalid security store capacity");
  }

  private legacyId(key: string) {
    return this.secretKeys
      ? createHash("sha256").update(key).digest("hex")
      : key;
  }
  private id(key: string) {
    return oidcLookup(this.sealer, this.model, "id", this.legacyId(key));
  }
  private condition(key: string) {
    return and(
      eq(oidcPayloads.model, this.model),
      eq(oidcPayloads.id, this.id(key)),
    );
  }
  private live() {
    return or(
      isNull(oidcPayloads.expiresAt),
      gt(oidcPayloads.expiresAt, new Date()),
    );
  }
  private decode(payload: JsonObject): T {
    if (!isString(payload.value) || payload.value.length > 2_800_000)
      throw new Error("Invalid durable security record");
    return deserialize(Buffer.from(payload.value, "base64"));
  }
  private encode(key: string, value: T) {
    const bytes = serialize(value);
    if (bytes.length > 2_000_000)
      throw new Error("Security record exceeds capacity");
    const record: BoundaryValue = overlapCast(value);
    const principalId = internalSecurityPrincipal(this.model, key, record);
    const payload: JsonObject = { value: bytes.toString("base64") };
    if (principalId) payload.accountId = principalId;
    return payload;
  }
  async get(key: string): Promise<T | undefined> {
    const [row] = await this.db
      .select()
      .from(oidcPayloads)
      .where(and(this.condition(key), this.live()))
      .limit(1);
    return row ? this.decode(openOidcRow(this.sealer, row)) : undefined;
  }
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }
  private expiry(value: T): Date | null {
    const record: BoundaryValue = overlapCast(value);
    const explicit =
      isTypeofObject(record) && record !== null && "expiresAt" in record
        ? record.expiresAt
        : undefined;
    if (explicit instanceof Date) return explicit;
    if (isNumber(explicit) && Number.isFinite(explicit))
      return new Date(explicit);
    return this.ttlMs === null ? null : new Date(Date.now() + this.ttlMs);
  }
  private async write(
    key: string,
    value: T,
    onlyIfAbsent: boolean,
  ): Promise<boolean> {
    const sealed = sealOidcRow(
      this.sealer,
      this.model,
      this.legacyId(key),
      this.encode(key, value),
    );
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:Capacity'), hashtext(${this.model}))`,
      );
      await tx
        .delete(oidcPayloads)
        .where(
          and(
            eq(oidcPayloads.model, this.model),
            lte(oidcPayloads.expiresAt, new Date()),
          ),
        );
      const existing = await tx
        .select({ id: oidcPayloads.id })
        .from(oidcPayloads)
        .where(this.condition(key))
        .limit(1);
      if (existing.length && onlyIfAbsent) return false;
      if (!existing.length) {
        const [size] = await tx
          .select({ count: sql<number>`count(*)::integer` })
          .from(oidcPayloads)
          .where(eq(oidcPayloads.model, this.model));
        if ((size?.count ?? this.capacity) >= this.capacity)
          throw new Error("Security store capacity exceeded");
      }
      const expiresAt = this.expiry(value);
      await tx
        .insert(oidcPayloads)
        .values({ ...sealed, expiresAt })
        .onConflictDoUpdate({
          target: [oidcPayloads.model, oidcPayloads.id],
          set: {
            payload: sealed.payload,
            sealScope: sealed.sealScope,
            uid: sealed.uid,
            userCode: sealed.userCode,
            grantId: sealed.grantId,
            expiresAt,
          },
        });
      return true;
    });
  }
  async set(key: string, value: T): Promise<this> {
    await this.write(key, value, false);
    return this;
  }
  async claim(key: string, value: T): Promise<boolean> {
    return this.write(key, value, true);
  }
  async delete(key: string): Promise<boolean> {
    return this.deleteEntry(this.id(key));
  }
  /** Only keys obtained by entries(); ordinary credential keys always use delete(). */
  async deleteEntry(storedKey: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:Capacity'), hashtext(${this.model}))`,
      );
      const rows = await tx
        .delete(oidcPayloads)
        .where(
          and(
            eq(oidcPayloads.model, this.model),
            eq(oidcPayloads.id, storedKey),
          ),
        )
        .returning({ id: oidcPayloads.id });
      return rows.length === 1;
    });
  }
  /** Atomic single-use consumption, shared by every replica. */
  async take(key: string): Promise<T | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:Capacity'), hashtext(${this.model}))`,
      );
      const [row] = await tx
        .delete(oidcPayloads)
        .where(and(this.condition(key), this.live()))
        .returning();
      return row ? this.decode(openOidcRow(this.sealer, row)) : undefined;
    });
  }
  get size(): Promise<number> {
    return this.db
      .select({ count: sql<number>`count(*)::integer` })
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), this.live()))
      .then((rows) => rows[0]?.count ?? 0);
  }
  async entries(): Promise<[string, T][]> {
    const rows = await this.db
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), this.live()))
      .limit(10_001);
    if (rows.length > 10_000)
      throw new Error("Security store capacity exceeded");
    return rows.map((row) => [
      row.id,
      this.decode(openOidcRow(this.sealer, row)),
    ]);
  }
  async values(): Promise<T[]> {
    return (await this.entries()).map(([, value]) => value);
  }
  async update(
    key: string,
    change: (current: T | undefined) => T | undefined,
  ): Promise<T | undefined> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:Capacity'), hashtext(${this.model}))`,
      );
      const store = new DurableMap<T>(
        overlapCast(tx),
        this.model,
        this.secretKeys,
        this.ttlMs,
        this.capacity,
        this.sealer,
      );
      const next = change(await store.get(key));
      if (next === undefined) await store.delete(key);
      else await store.set(key, next);
      return next;
    });
  }
}

export type SecurityMap<T> = Map<string, T> | DurableMap<T>;

export async function updateSecurityMap<T>(
  store: SecurityMap<T>,
  key: string,
  change: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  if (store instanceof DurableMap) return store.update(key, change);
  const next = change(store.get(key));
  if (next === undefined) store.delete(key);
  else store.set(key, next);
  return next;
}

export async function takeSecurityMap<T>(
  store: SecurityMap<T>,
  key: string,
): Promise<T | undefined> {
  if (store instanceof DurableMap) return store.take(key);
  const current = store.get(key);
  store.delete(key);
  return current;
}

export async function incrementSecurityCounter(
  store: SecurityMap<number>,
  key: string,
): Promise<number> {
  const count = await updateSecurityMap(store, key, (current) =>
    Math.min((current ?? 0) + 1, 1_000_000),
  );
  if (count === undefined) throw new Error("Security counter unavailable");
  return count;
}

export async function deleteSecurityMapEntry<T>(
  store: SecurityMap<T>,
  key: string,
): Promise<boolean> {
  return store instanceof DurableMap
    ? store.deleteEntry(key)
    : store.delete(key);
}
