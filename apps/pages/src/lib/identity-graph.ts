import type { Connection, ConnectionStatus, Provider } from "./connections.js";
import { kvGet, kvSet } from "./kv.js";
import {
  type VaultItem,
  createItem,
  hostOf,
  itemSubtitle,
} from "./vault/model.js";

export const FIRST_RUN_KEY = "connections.firstRun.v1";
export const FIRST_RUN_PROVIDER_IDS = ["github", "vercel", "linear"] as const;

export const UNFINISHED_STATUSES: readonly ConnectionStatus[] = [
  "pending",
  "needs_reauth",
  "expired",
  "error",
];

export type StatusVerb =
  | "connected"
  | "needs_you"
  | "needs_install"
  | "broken"
  | "idle";

export function isUnfinished(connection: Connection): boolean {
  return UNFINISHED_STATUSES.includes(connection.status);
}

export function unfinishedConnections(connections: Connection[]): Connection[] {
  return connections.filter(
    (connection) => connection.status !== "revoked" && isUnfinished(connection),
  );
}

export function connectionVerb(status: ConnectionStatus): StatusVerb {
  switch (status) {
    case "active":
      return "connected";
    case "pending":
    case "needs_reauth":
    case "expired":
      return "needs_you";
    case "error":
      return "broken";
    default:
      return "idle";
  }
}

export function providerVerb(
  provider: Provider,
  connection: Connection | null,
): StatusVerb {
  if (connection) return connectionVerb(connection.status);
  if (!provider.configured && !provider.autoConfigurable)
    return "needs_install";
  return "idle";
}

export const VERB_LABEL: Record<StatusVerb, string> = {
  connected: "Connected",
  needs_you: "Needs you",
  needs_install: "Needs install",
  broken: "Broken",
  idle: "Not enabled",
};

export const VERB_CHIP: Record<StatusVerb, string> = {
  connected: "chip--ok",
  needs_you: "chip--warn",
  needs_install: "chip--warn",
  broken: "chip--err",
  idle: "chip",
};

export type AddPipe = "oauth" | "key" | "login";

export function addPipe(provider: Provider): AddPipe {
  if (provider.authKind === "oauth2_authorization_code") return "oauth";
  if (
    provider.authKind === "api_key" ||
    provider.authKind === "configuration"
  ) {
    return "key";
  }
  return "login";
}

export function providerHosts(provider: Provider): string[] {
  const hosts = new Set<string>();
  for (const authority of provider.egress?.authorities ?? []) {
    const host = hostOf(authority) || authority.toLowerCase();
    if (host) hosts.add(host.replace(/^www\./, ""));
  }
  if (provider.id === "github") hosts.add("github.com");
  if (provider.id === "linear") hosts.add("linear.app");
  if (provider.id === "stripe") hosts.add("stripe.com");
  return [...hosts];
}

export function itemMatchesProvider(
  item: VaultItem,
  provider: Provider,
): boolean {
  if (item.deletedAt) return false;
  const id = provider.id.toLowerCase();
  const name = provider.displayName.toLowerCase();
  const hosts = providerHosts(provider);
  const haystack = [item.name, itemSubtitle(item)].join(" ").toLowerCase();
  if (haystack.includes(id) || haystack.includes(name)) return true;
  if (item.kind === "login") {
    return item.uris.some((uri) => {
      const host = hostOf(uri.uri)
        .replace(/^www\./, "")
        .toLowerCase();
      return (
        hosts.includes(host) ||
        host === id ||
        host.endsWith(`.${id}.com`) ||
        uri.uri.toLowerCase().includes(id)
      );
    });
  }
  if (item.kind === "passkey") {
    const rp = item.rpId.replace(/^www\./, "").toLowerCase();
    return hosts.includes(rp) || rp === id || rp.includes(id);
  }
  if (item.kind === "secret") {
    const ref = item.connectionRef.toLowerCase();
    return ref.includes(`/${id}/`) || ref.includes(id) || haystack.includes(id);
  }
  return false;
}

export function vaultItemsForProvider(
  items: VaultItem[],
  provider: Provider,
): VaultItem[] {
  return items.filter((item) => itemMatchesProvider(item, provider));
}

export function suggestedLoginUri(provider: Provider): string {
  const host = providerHosts(provider)[0];
  return host ? `https://${host}` : "";
}

export function hasConnectorReminder(
  items: VaultItem[],
  connection: Connection,
): boolean {
  return items.some(
    (item) =>
      item.kind === "secret" &&
      item.deletedAt === null &&
      item.connectionRef === connection.connectionRef,
  );
}

export function buildConnectorReminder(
  provider: Provider,
  connection: Connection,
): VaultItem {
  const item = createItem("secret", `${provider.displayName} connector`);
  if (item.kind === "secret") {
    item.value = "";
    item.connectionRef = connection.connectionRef;
    item.notes =
      "Credential stays on the Host. This item is a reminder and a grant target for agents.";
  }
  return item;
}

export function firstRunDismissed(): boolean {
  return kvGet(FIRST_RUN_KEY) === "done";
}

export function dismissFirstRun(): void {
  kvSet(FIRST_RUN_KEY, "done");
}

export function firstRunProviders(providers: Provider[]): Provider[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const preferred = FIRST_RUN_PROVIDER_IDS.map((id) => byId.get(id)).filter(
    (provider): provider is Provider => provider !== undefined,
  );
  if (preferred.length >= 3) return preferred.slice(0, 3);
  const extra = providers.filter(
    (provider) =>
      !preferred.some((item) => item.id === provider.id) &&
      !provider.autoConfigurable,
  );
  return [...preferred, ...extra].slice(0, 3);
}
