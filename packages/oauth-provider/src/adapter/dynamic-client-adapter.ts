import { overlapCast } from "@opensesame/os-domain";
import type { OidcAdapterConstructor, OidcAdapterPayload } from "./types.js";

/**
 * Wrap an oidc-provider adapter constructor so `Client` finds can resolve
 * clients held in the durable {@link ClientRecordStore} (ADR 0050 R-C).
 *
 * The loader is *lookup-only*: it must never admit or insert a client.
 * Auto-admission of origin_profile clients happens on the authorization path
 * (`/auth` prefetch via `ensureOriginClient`), so unauthenticated `/token`
 * probes cannot flood the store with origin rows (ADR 0050 F2).
 */
export function withDynamicClientLoader(
  Base: OidcAdapterConstructor,
  loadClient: (clientId: string) => Promise<OidcAdapterPayload | undefined>,
): OidcAdapterConstructor {
  return class DynamicClientAdapter extends Base {
    private readonly modelName: string;

    constructor(name: string) {
      super(name);
      this.modelName = name;
    }

    async find(id: string): Promise<OidcAdapterPayload | undefined> {
      if (this.modelName === "Client") {
        const dynamic = await loadClient(id);
        if (dynamic) return dynamic;
      }
      return overlapCast(super.find(id));
    }
  };
}
