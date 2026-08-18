import type { Adapter, AdapterPayload } from "oidc-provider";
import type { OidcAdapterConstructor } from "./types.js";

type Stored = {
  payload: AdapterPayload;
  expiresAt: number | null;
};

/**
 * In-memory oidc-provider adapter for unit/integration tests only.
 * Production must use createPostgresAdapterConstructor.
 */
export function createMemoryAdapterConstructor(): OidcAdapterConstructor {
  const bags = new Map<string, Map<string, Stored>>();
  const byGrant = new Map<string, Set<string>>();
  const byUserCode = new Map<string, string>();
  const byUid = new Map<string, string>();

  function bag(model: string): Map<string, Stored> {
    let m = bags.get(model);
    if (!m) {
      m = new Map();
      bags.set(model, m);
    }
    return m;
  }

  function key(model: string, id: string): string {
    return `${model}:${id}`;
  }

  function dropIndexes(model: string, id: string, payload: AdapterPayload): void {
    const composite = key(model, id);
    if (payload.grantId) {
      const set = byGrant.get(payload.grantId);
      set?.delete(composite);
      if (set && set.size === 0) byGrant.delete(payload.grantId);
    }
    if (typeof payload.userCode === "string") {
      if (byUserCode.get(payload.userCode) === composite) {
        byUserCode.delete(payload.userCode);
      }
    }
    if (typeof payload.uid === "string") {
      if (byUid.get(payload.uid) === composite) {
        byUid.delete(payload.uid);
      }
    }
  }

  function purgeExpired(model: string, id: string): AdapterPayload | undefined {
    const entry = bag(model).get(id);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      bag(model).delete(id);
      dropIndexes(model, id, entry.payload);
      return undefined;
    }
    return entry.payload;
  }

  return class MemoryAdapter implements Adapter {
    constructor(private readonly name: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      const expiresAt =
        typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : null;
      bag(this.name).set(id, { payload: { ...payload }, expiresAt });

      const composite = key(this.name, id);
      if (payload.grantId) {
        let set = byGrant.get(payload.grantId);
        if (!set) {
          set = new Set();
          byGrant.set(payload.grantId, set);
        }
        set.add(composite);
      }
      if (typeof payload.userCode === "string") {
        byUserCode.set(payload.userCode, composite);
      }
      if (typeof payload.uid === "string") {
        byUid.set(payload.uid, composite);
      }
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      return purgeExpired(this.name, id);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      const composite = byUserCode.get(userCode);
      if (!composite) return undefined;
      const [model, id] = splitComposite(composite);
      if (!model || !id || model !== this.name) return undefined;
      return purgeExpired(model, id);
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const composite = byUid.get(uid);
      if (!composite) return undefined;
      const [model, id] = splitComposite(composite);
      if (!model || !id || model !== this.name) return undefined;
      return purgeExpired(model, id);
    }

    async destroy(id: string): Promise<void> {
      const existing = bag(this.name).get(id);
      bag(this.name).delete(id);
      if (existing) dropIndexes(this.name, id, existing.payload);
    }

    async consume(id: string): Promise<void> {
      const entry = bag(this.name).get(id);
      if (entry) {
        entry.payload.consumed = Math.floor(Date.now() / 1000);
      }
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      const members = byGrant.get(grantId);
      if (!members) return;
      for (const composite of members) {
        const [model, id] = splitComposite(composite);
        if (model && id) {
          bag(model).delete(id);
        }
      }
      byGrant.delete(grantId);
    }
  };
}

function splitComposite(composite: string): [string | undefined, string | undefined] {
  const idx = composite.indexOf(":");
  if (idx < 0) return [undefined, undefined];
  return [composite.slice(0, idx), composite.slice(idx + 1)];
}
