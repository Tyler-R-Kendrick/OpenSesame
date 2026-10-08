import type { VaultItem } from "@opensesame/vault-core";
import { vaultStore } from "../vault/store.js";
import { vaultWrite } from "./field-write.js";
import type { HostInput, RelaySource } from "./host-input.js";
import { LiveHost, MAX_SESSION_MS } from "./host.js";
import { hostRoutes } from "./session-carriers.js";
import { DIRECT_TRANSPORT } from "./transport.js";
import { vaultCatalog, vaultField } from "./vault-share.js";

/** The session's host and the routes its link carries, built but not yet live. */
export async function buildHost(
  input: HostInput,
  post: (code: string) => void,
  source: RelaySource,
  assertAuthority: () => void,
  items: () => readonly VaultItem[],
) {
  // The host clamps the lifetime; the catalog states the clamped one.
  const expiresAt = Math.min(
    Date.now() + input.minutes * 60_000,
    Date.now() + MAX_SESSION_MS,
  );
  assertAuthority();
  const transport = input.transport ?? DIRECT_TRANSPORT;
  const { secret, routes, own, ice } = await hostRoutes(transport, expiresAt);
  assertAuthority();
  const next = await LiveHost.start({
    assertAuthority,
    admission: input.admission,
    ice,
    routes,
    secret,
    relay: (name) => source.carriers?.seat(name) ?? null,
    post,
    expiresAt,
    catalog: () =>
      vaultCatalog({
        title: input.title,
        policy: input.policy,
        expiresAt,
        scope: input.scope,
        items,
      }),
    readField: vaultField({ scope: input.scope, items }),
    writeField: (item, field, value, ceiling = assertAuthority) =>
      vaultWrite({ scope: input.scope, items }, (next) => {
        assertAuthority();
        ceiling();
        return vaultStore.saveItem(next, undefined, ceiling);
      })(item, field, value),
    peers: input.peers,
  });
  try {
    assertAuthority();
  } catch (error) {
    next.end();
    throw error;
  }
  return { next, routes, own };
}
