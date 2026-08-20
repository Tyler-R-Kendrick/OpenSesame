import { type JsonObject, type BoundaryValue } from "@opensesame/os-domain";
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
    [key: string]: import("@opensesame/os-domain").JsonValue | import("@opensesame/os-domain").BoundaryValue | undefined;
  };

  export type AdapterPayload = JsonObject & {
    grantId?: string;
    userCode?: string;
    uid?: string;
    consumed?: number;
  };

  export interface Adapter {
    upsert(
      id: string,
      payload: AdapterPayload,
      expiresIn?: number,
    ): Promise<void>;
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
    cookies?: JsonObject;
    features?: JsonObject;
    jwks?: { keys: JsonObject[] };
    pkce?: {
      required?: (ctx: KoaContext, client: BoundaryValue) => boolean;
    };
    subjectTypes?: Array<"public" | "pairwise">;
    pairwiseIdentifier?: (
      ctx: KoaContext,
      accountId: string,
      client: {
        clientId?: string;
        sectorIdentifier?: string;
        [k: string]: import("@opensesame/os-domain").JsonValue | undefined;
      },
    ) => Promise<string> | string;
    findAccount?: (
      ctx: KoaContext,
      id: string,
    ) => Promise<
      | {
          accountId: string;
          claims: (
            use: string,
            scope: string,
          ) => Promise<JsonObject> | JsonObject;
        }
      | undefined
    >;
    ttl?: JsonObject;
    routes?: Record<string, string>;
    scopes?: string[];
    claims?: JsonObject;
    interactions?: JsonObject;
    renderError?: (...args: unknown[]) => BoundaryValue;
    [key: string]: import("@opensesame/os-domain").JsonValue | import("@opensesame/os-domain").BoundaryValue | undefined;
  };

  export class Provider {
    constructor(issuer: string, configuration?: Configuration);
    callback(): (req: BoundaryValue, res: BoundaryValue) => void;
    app: {
      callback(): (req: BoundaryValue, res: BoundaryValue) => void;
      listen: (...args: unknown[]) => BoundaryValue;
    };
    Client: { find(id: string): Promise<BoundaryValue> };
    registerGrantType(...args: unknown[]): void;
    [key: string]: import("@opensesame/os-domain").JsonValue | import("@opensesame/os-domain").BoundaryValue | undefined;
  }

  type OidcErrorConstructor = new (...args: unknown[]) => Error;

  export const errors: Record<string, OidcErrorConstructor | undefined> & {
    InvalidTarget: OidcErrorConstructor;
    InvalidRequest: OidcErrorConstructor;
    InvalidClient: OidcErrorConstructor;
  };
  export default Provider;
}
