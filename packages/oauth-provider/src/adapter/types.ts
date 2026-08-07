import type { Adapter, AdapterPayload } from "oidc-provider";

/**
 * oidc-provider adapter contract used by OpenSesame.
 * MemoryAdapter implements this for tests; PostgresAdapter is the production seam.
 */
export type OidcAdapter = Adapter;
export type OidcAdapterPayload = AdapterPayload;

export type OidcAdapterConstructor = new (name: string) => OidcAdapter;

/**
 * Persistence backend for the oidc-provider Adapter constructor.
 * Control-plane / database package should implement this against PostgreSQL.
 */
export interface PostgresOidcStore {
  upsert(
    model: string,
    id: string,
    payload: OidcAdapterPayload,
    expiresAt: Date | null,
  ): Promise<void>;
  find(model: string, id: string): Promise<OidcAdapterPayload | undefined>;
  findByUserCode(model: string, userCode: string): Promise<OidcAdapterPayload | undefined>;
  findByUid(model: string, uid: string): Promise<OidcAdapterPayload | undefined>;
  destroy(model: string, id: string): Promise<void>;
  consume(model: string, id: string): Promise<void>;
  revokeByGrantId(grantId: string): Promise<void>;
}

/**
 * Factory that binds a PostgresOidcStore into an oidc-provider Adapter constructor.
 */
export function createPostgresAdapterConstructor(
  store: PostgresOidcStore,
): OidcAdapterConstructor {
  return class PostgresAdapter implements OidcAdapter {
    constructor(private readonly name: string) {}

    async upsert(id: string, payload: OidcAdapterPayload, expiresIn?: number): Promise<void> {
      const expiresAt =
        typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000) : null;
      await store.upsert(this.name, id, payload, expiresAt);
    }

    async find(id: string): Promise<OidcAdapterPayload | undefined> {
      return store.find(this.name, id);
    }

    async findByUserCode(userCode: string): Promise<OidcAdapterPayload | undefined> {
      return store.findByUserCode(this.name, userCode);
    }

    async findByUid(uid: string): Promise<OidcAdapterPayload | undefined> {
      return store.findByUid(this.name, uid);
    }

    async destroy(id: string): Promise<void> {
      await store.destroy(this.name, id);
    }

    async consume(id: string): Promise<void> {
      await store.consume(this.name, id);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await store.revokeByGrantId(grantId);
    }
  };
}
