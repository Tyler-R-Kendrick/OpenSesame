/**
 * Host session construction (split from `session.ts` for the size budget).
 */

import type { VaultItem } from "@opensesame/vault-core";
import { vaultStore } from "../vault/store.js";
import { connectionPort } from "./connection-port.js";
import type { ResetItem } from "./device-reset-types.js";
import { vaultWrite } from "./field-write.js";
import { type HostOptions, LiveHost, MAX_SESSION_MS } from "./host.js";
import type { SharePolicy } from "./messages.js";
import type { TransportFactory } from "./p2p.js";
import type { Rendezvous } from "./rendezvous.js";
import { hostRoutes } from "./session-carriers.js";
import { provisionLiveSessionGuest } from "./session-provision.js";
import { DIRECT_TRANSPORT, type LiveTransport } from "./transport.js";
import type { ShareScope } from "./vault-share.js";
import { sharedItems, vaultCatalog, vaultField } from "./vault-share.js";

function resetItems(
  items: readonly VaultItem[],
  scope: ShareScope,
): ResetItem[] {
  return sharedItems(items, scope).flatMap((item) => {
    if (item.kind !== "account") return [];
    const origins = [
      ...new Set(
        item.uris.flatMap(({ uri }) => {
          try {
            const url = new URL(uri);
            return url.protocol === "https:" ? [url.origin] : [];
          } catch {
            return [];
          }
        }),
      ),
    ];
    return [{ id: item.id, name: item.name, origins }];
  });
}

export type HostBuildInput = Readonly<{
  title: string;
  provision?: Readonly<{
    audience: "anyone" | "all-users" | "people";
    peopleIds: readonly string[];
  }>;
  scope: ShareScope;
  policy: SharePolicy;
  admission: "invite" | "open";
  minutes: number;
  transport: TransportFactory;
  /** The owner's routes profile; direct only when absent. */
  routes?: LiveTransport;
  /** Let devices ask to use the owner's connections (ADR 0196). */
  devices?: boolean;
  /** Let devices ask for exact password-reset capabilities. */
  resets?: boolean;
}>;

export type RelaySource = { carriers: Rendezvous | null };

type ProvisionOptions = {
  provisionSeat?: NonNullable<HostOptions["provisionSeat"]>;
};

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
  const profile = input.routes ?? DIRECT_TRANSPORT;
  const { secret, routes, own, routing } = await hostRoutes(profile, expiresAt);
  const scope = input.scope;
  const provision = input.provision;
  const provisioning: ProvisionOptions = {};
  if (provision) {
    provisioning.provisionSeat = (guest, hostId) =>
      provisionLiveSessionGuest({
        tomb: vaultStore.activeTomb(),
        hostId,
        guest,
        scope,
        policy: input.policy,
        minutes: input.minutes,
        expiresAt,
        audience: provision.audience,
        peopleIds: provision.peopleIds,
        items: items(),
      });
  }
  const next = await LiveHost.start({
    admission: input.admission,
    transport: input.transport(routing),
    routes,
    secret,
    relay: (name) => source.carriers?.seat(name) ?? null,
    canRelay: () => source.carriers?.relays ?? false,
    devices: input.devices ? { port: connectionPort } : undefined,
    resets: input.resets
      ? { items: () => resetItems(items(), scope) }
      : undefined,
    ...provisioning,
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
  });
  // A vault edit or a newly created item changes what the next catalog says;
  // send it to joined guests without making them re-greet.
  let stopVault = () => {};
  const stopState = next.subscribe((state) => {
    if (state.status !== "ended") return;
    stopVault();
    stopState();
  });
  stopVault = vaultStore.subscribe(() => next.refreshCatalog());
  return { next, routes, own };
}
