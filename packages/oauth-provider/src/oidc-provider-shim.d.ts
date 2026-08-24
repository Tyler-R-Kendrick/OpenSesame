/**
 * Minimal ambient types for panva/oidc-provider (ESM, no bundled .d.ts).
 * Only the surface OpenSesame configures is declared.
 */
declare module "oidc-provider" {
  export type KoaContext = import("@opensesame/os-domain").BoundaryValue;

  export type ClientMetadata = {
    client_id: string;
    client_name?: string;
    client_secret?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
    subject_type?: "public" | "pairwise";
    sector_identifier_uri?: string;
    scope?: string;
    application_type?: "web" | "native";
  };

  export type AdapterPayload = import("@opensesame/os-domain").JsonObject & {
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
    cookies?: import("@opensesame/os-domain").JsonObject;
    features?: import("@opensesame/os-domain").BoundaryValue;
    jwks?: { keys: import("@opensesame/os-domain").JsonObject[] };
    pkce?: {
      required?: (
        ctx: KoaContext,
        client: import("@opensesame/os-domain").BoundaryValue,
      ) => boolean;
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
          ) =>
            | Promise<import("@opensesame/os-domain").JsonObject>
            | import("@opensesame/os-domain").JsonObject;
        }
      | undefined
    >;
    /**
     * Additional authorization/PAR/device/CIBA request parameters that reach
     * `ctx.oidc.params` and the interaction session (oidc-provider 9.x).
     * Accepts an iterable of names, or an object mapping each name to a
     * validator called as `(ctx, value, client)` — `null`/`undefined` registers
     * the name without validation.
     */
    extraParams?:
      | string[]
      | Record<
          string,
          | ((
              ctx: KoaContext,
              value: string | undefined,
              client: import("@opensesame/os-domain").BoundaryValue,
            ) => void | Promise<void>)
          | null
        >;
    ttl?: import("@opensesame/os-domain").JsonObject;
    routes?: Record<string, string>;
    scopes?: string[];
    claims?: import("@opensesame/os-domain").JsonObject;
    interactions?: import("@opensesame/os-domain").JsonObject;
  };

  export class Provider {
    constructor(issuer: string, configuration?: Configuration);
    callback(): (
      req: import("@opensesame/os-domain").BoundaryValue,
      res: import("@opensesame/os-domain").BoundaryValue,
    ) => void;
    Client: {
      find(id: string): Promise<import("@opensesame/os-domain").BoundaryValue>;
    };
  }

  type OidcErrorConstructor = new (message?: string) => Error;

  export const errors: Record<string, OidcErrorConstructor | undefined> & {
    InvalidTarget: OidcErrorConstructor;
    InvalidRequest: OidcErrorConstructor;
    InvalidClient: OidcErrorConstructor;
  };
  export default Provider;
}
