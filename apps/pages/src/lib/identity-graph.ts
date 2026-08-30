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
  // Only the Host sealing key is a page-wide deployment fault. Missing OAuth
  // app env vars are the normal default for the catalog — not tile errors.
  if (
    !provider.configured &&
    provider.missingConfig.some((name) => name.includes("CONNECTION_KEY"))
  ) {
    return "needs_install";
  }
  return "idle";
}

export const VERB_LABEL = {
  connected: "Connected",
  needs_you: "Needs you",
  needs_install: "Needs install",
  broken: "Broken",
  idle: "Not enabled",
};

export const VERB_CHIP = {
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
  const hosts = providerHosts(provider);
  const site =
    hosts.find((host) => host === `${provider.id}.com`) ??
    hosts.find((host) => !host.startsWith("api.")) ??
    hosts[0];
  return site ? `https://${site}` : "";
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
      "Credential stays on the Host. This item is a reminder and a grant target.";
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

export type GraphDoorKind = "host" | "login" | "passkey" | "reminder";

export type GraphDoor = {
  kind: GraphDoorKind;
  title: string;
  detail: string;
  verb: StatusVerb;
  href: string | null;
  action: string;
};

export function vaultCreateHref(
  kind: "login" | "passkey" | "secret",
  provider: Provider,
  connection?: Connection | null,
): string {
  const params = new URLSearchParams();
  params.set(
    "name",
    kind === "secret"
      ? `${provider.displayName} connector`
      : provider.displayName,
  );
  const uri = suggestedLoginUri(provider);
  if (uri && kind !== "secret") params.set("uri", uri);
  if (kind === "secret" && connection) {
    params.set("ref", connection.connectionRef);
  }
  return `/vault/new/${kind}?${params.toString()}`;
}

export function grantableAgentId(raw: string): string | null {
  const id = raw.trim();
  if (!id || id === "user:demo" || id.startsWith("user:")) return null;
  return id;
}

export function grantReminderToAgent(
  reminder: VaultItem,
  agentId: string,
): VaultItem {
  if (reminder.kind !== "secret") return reminder;
  if (reminder.grantees.includes(agentId)) return reminder;
  return { ...reminder, grantees: [...reminder.grantees, agentId] };
}

export function graphDoors(
  provider: Provider,
  connections: Connection[],
  items: VaultItem[],
): GraphDoor[] {
  const liveConnections = connections.filter(
    (connection) => connection.status !== "revoked",
  );
  const liveItems = vaultItemsForProvider(items, provider);
  const connection = liveConnections[0] ?? null;
  const logins = liveItems.filter((item) => item.kind === "login");
  const passkeys = liveItems.filter((item) => item.kind === "passkey");
  const reminders = liveItems.filter((item) => item.kind === "secret");
  const unfinished = liveConnections.find((row) => isUnfinished(row));
  const hostVerb = unfinished
    ? connectionVerb(unfinished.status)
    : providerVerb(provider, connection);
  const hostHref = unfinished
    ? `/connections/${encodeURIComponent(provider.id)}/${encodeURIComponent(unfinished.connectionId)}#authorization`
    : "#authorization";

  return [
    {
      kind: "host",
      title: "Host connector",
      detail:
        liveConnections.length === 0
          ? "None. Authorize so agents can invoke without a pasted token."
          : liveConnections
              .map(
                (item) =>
                  `${item.logicalName} · ${VERB_LABEL[connectionVerb(item.status)]}`,
              )
              .join(" · "),
      verb: hostVerb,
      href: hostHref,
      action:
        liveConnections.length === 0
          ? addPipe(provider) === "oauth"
            ? "Authorize"
            : addPipe(provider) === "key"
              ? "Save a key"
              : "Configure"
          : unfinished
            ? "Fix"
            : "Open",
    },
    {
      kind: "login",
      title: "Vault login",
      detail:
        summarizeItems(logins) ??
        `None saved. A ${provider.displayName} password lives here, not on the Host.`,
      verb: logins.length > 0 ? "connected" : "idle",
      href:
        logins[0] !== undefined
          ? `/vault/${logins[0].id}`
          : vaultCreateHref("login", provider),
      action: logins.length > 0 ? "Open" : "Save a login",
    },
    {
      kind: "passkey",
      title: "Passkey",
      detail:
        summarizeItems(passkeys) ??
        "None. The private key stays on your phone or security key.",
      verb: passkeys.length > 0 ? "connected" : "idle",
      href:
        passkeys[0] !== undefined
          ? `/vault/${passkeys[0].id}`
          : vaultCreateHref("passkey", provider),
      action: passkeys.length > 0 ? "Open" : "Record metadata",
    },
    {
      kind: "reminder",
      title: "Vault reminder",
      detail:
        summarizeItems(reminders) ??
        "None. A reminder stores the ConnectionRef, never the provider token.",
      verb: reminders.length > 0 ? "connected" : "idle",
      href:
        reminders[0] !== undefined
          ? `/vault/${reminders[0].id}`
          : connection
            ? vaultCreateHref("secret", provider, connection)
            : "#authorization",
      action:
        reminders.length > 0
          ? "Open"
          : connection
            ? "Remember"
            : "Authorize first",
    },
  ];
}

function summarizeItems(items: VaultItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((item) => `${item.name || itemSubtitle(item)}`).join(" · ");
}
