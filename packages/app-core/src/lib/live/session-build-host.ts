/**
 * Host session construction (split from `session.ts` for the size budget).
 */

import type { VaultItem } from "@opensesame/vault-core";
import { vaultStore } from "../vault/store.js";
import { vaultWrite } from "./field-write.js";
import { LiveHost, MAX_SESSION_MS } from "./host.js";
import type { SharePolicy } from "./messages.js";
import type { PeerFactory } from "./peer.js";
import type { Rendezvous } from "./rendezvous.js";
import { hostRoutes } from "./session-carriers.js";
import { DIRECT_TRANSPORT, type LiveTransport } from "./transport.js";
import type { ShareScope } from "./vault-share.js";
import { vaultCatalog, vaultField } from "./vault-share.js";

export type HostBuildInput = Readonly<{
  title: string;
  scope: ShareScope;
  policy: SharePolicy;
  admission: "invite" | "open";
  minutes: number;
  peers: PeerFactory;
  transport?: LiveTransport;
}>;

export type RelaySource = { carriers: Rendezvous | null };

export async function buildLiveHost(
  input: HostBuildInput,
  items: () => readonly VaultItem[],
  post: (code: string) => void,
  source: RelaySource,
) {
  const expiresAt = Math.min(
    Date.now() + input.minutes * 60_000,
    Date.now() + MAX_SESSION_MS,
  );
  const transport = input.transport ?? DIRECT_TRANSPORT;
  const { secret, routes, own, ice } = await hostRoutes(transport, expiresAt);
  const scope = input.scope;
  const next = await LiveHost.start({
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
        scope,
        items,
      }),
    readField: vaultField({ scope, items }),
    writeField: vaultWrite({ scope, items }, (item) =>
      vaultStore.saveItem(item),
    ),
    peers: input.peers,
  });
  return { next, routes, own };
}
