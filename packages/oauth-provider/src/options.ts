import type { ClientMetadata, Configuration } from "oidc-provider";
import type { OidcAdapterConstructor } from "./adapter/types.js";
import type { LookupAccount, MapClaims } from "./claims/find-account.js";
import type { ClientRecordStore } from "./clients/store.js";
import type { FindStoredConsent } from "./consent/load-existing-grant.js";
import type { JwtReplayCache } from "./grants/replay-cache.js";
import type { MtlsTransport } from "./mtls/feature.js";
import type { ProviderPageOptions } from "./pages.js";
import type { OAuthProviderEnv, PairwiseSubjectStore } from "./types.js";

/** What `createOpenSesameProvider` is built from. Every field is optional. */
export interface CreateOpenSesameProviderOptions {
  issuer?: string;
  env?: Partial<OAuthProviderEnv>;
  processEnv?: NodeJS.ProcessEnv;
  adapter?: OidcAdapterConstructor;
  pairwiseStore?: PairwiseSubjectStore;
  /**
   * Durable client records (ADR 0050 R-C). Defaults to an in-memory store
   * seeded from `options.clients`, so existing callers behave unchanged.
   */
  clientStore?: ClientRecordStore;
  clients?: ClientMetadata[];
  /**
   * Deployment/system principal that owns newly auto-admitted origin clients
   * (ADR 0050 R-A). Optional so existing callers behave unchanged; the
   * control plane always passes it.
   */
  systemOwnerPrincipalId?: string;
  /** When omitted, MemoryAdapter is used (tests / local). Production should pass Postgres adapter. */
  jwks?: Configuration["jwks"];
  /**
   * Durable consent lookup for grant reuse across sessions. When provided,
   * a returning account whose stored consent covers every requested scope
   * skips the consent interaction: `loadExistingGrant` materialises a Grant
   * from this record instead of prompting again. Absent (the default), only
   * oidc-provider's session-scoped grant reuse applies — existing callers
   * behave unchanged. Return `null` when no live consent exists.
   */
  findStoredConsent?: FindStoredConsent;
  /** Null/suspended accounts fail issuance (ADV-17). Absent: any id is `{sub}`. */
  lookupAccount?: LookupAccount;
  /** Extra claim mapping; reserved protocol claims are fenced (ADV-16). */
  mapClaims?: MapClaims;
  replayCache?: JwtReplayCache;
  /** RFC 8705 (ID-OAUTH): set only with a TLS listener; absent keeps mTLS off. */
  transport?: MtlsTransport;
  /**
   * The pages the provider draws itself (errors, device flow, logout). The
   * identity plane passes its own stylesheet; absent, a plain one is used.
   */
  pages?: ProviderPageOptions;
}
