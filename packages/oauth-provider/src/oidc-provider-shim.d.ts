/**
 * Minimal ambient types for panva/oidc-provider (ESM, no bundled .d.ts).
 * Only the surface OpenSesame configures is declared.
 */
declare module "oidc-provider" {
  export type KoaContext = {
    oidc?: unknown;
    method?: string;
    path?: string;
    status?: number;
    body?: unknown;
  };

  export type ClientMetadata = {
    client_id: string;
    client_secret?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
    subject_type?: "public" | "pairwise";
    sector_identifier_uri?: string;
    [key: string]: unknown;
  };

  export type AdapterPayload = Record<string, unknown> & {
    grantId?: string;
    userCode?: string;
    uid?: string;
    consumed?: number;
  };

  export interface Adapter {
    upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void>;
    find(id: string): Promise<AdapterPayload | undefined>;
    findByUserCode?(userCode: string): Promise<AdapterPayload | undefined>;
    findByUid?(uid: string): Promise<AdapterPayload | undefined>;
    destroy(id: string): Promise<void>;
    revokeByGrantId?(grantId: string): Promise<void>;
    consume?(id: string): Promise<void>;
  }

  export type AdapterConstructor = new (name: string) => Adapter;

  export type Configuration = {
    adapter?: AdapterConstructor;
    clients?: ClientMetadata[];
    cookies?: Record<string, unknown>;
    features?: Record<string, unknown>;
    jwks?: { keys: Record<string, unknown>[] };
    pkce?: {
      required?: (ctx: KoaContext, client: unknown) => boolean;
    };
    subjectTypes?: Array<"public" | "pairwise">;
    pairwiseIdentifier?: (
      ctx: KoaContext,
      accountId: string,
      client: { clientId?: string; sectorIdentifier?: string; [k: string]: unknown },
    ) => Promise<string> | string;
    findAccount?: (
      ctx: KoaContext,
      id: string,
    ) => Promise<{
      accountId: string;
      claims: (use: string, scope: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
    } | undefined>;
    ttl?: Record<string, unknown>;
    routes?: Record<string, string>;
    scopes?: string[];
    claims?: Record<string, unknown>;
    interactions?: Record<string, unknown>;
    renderError?: (...args: unknown[]) => unknown;
    [key: string]: unknown;
  };

  export class Provider {
    constructor(issuer: string, configuration?: Configuration);
    callback(): (req: unknown, res: unknown) => void;
    app: { callback(): (req: unknown, res: unknown) => void; listen: (...args: unknown[]) => unknown };
    Client: { find(id: string): Promise<unknown> };
    registerGrantType(...args: unknown[]): void;
    [key: string]: unknown;
  }

  export const errors: Record<string, new (...args: unknown[]) => Error>;
  export default Provider;
}
