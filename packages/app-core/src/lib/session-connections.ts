/**
 * The connections this app offers a device in a live session (ADR 0195).
 *
 * The owner of a session may let a device use some of the connections saved on
 * this device. What a device may *do* with one is decided here, in a closed
 * table of read-only operations — never inferred from what a driver happens to
 * accept — and is value-blind: an operation reports who a credential belongs
 * to, what it can list, which tools a server has; it never returns the
 * credential, a secret read through it, or anything a driver keeps for its
 * own use. Reading a secret (`provider.secret.read`) and calling an MCP tool
 * (which can act on the owner's account) are not on the table.
 *
 * Nothing here is cached. Each `list` and each `invoke` asks the stores as
 * they stand, so a connection the owner removed, or that needs authorizing
 * again, stops being offered — and a call already granted to it is refused.
 */

import type { Connection } from "./connections.js";
import { isNativeDeviceConnection } from "./device-connector-view.js";
import { listDeviceConnections } from "./device-connectors.js";
import { invokeLinearConnector } from "./linear-operations.js";
import type {
  ConnectionPort,
  SessionConnection,
  SessionResult,
} from "./live/connection-port.js";
import { nativeBrowserMethodPolicy } from "./native-browser-policy.js";
import { nativeConnectorDriver } from "./native-connector-drivers.js";
import { readNativeConnector } from "./native-connector-store.js";
import type { NativeConnectorView } from "./native-connector-view.js";

/** Linear reads, through its typed operations. */
const LINEAR_OPERATIONS = ["issues.list", "projects.list", "teams.list"];

/**
 * What a device may ask of a native connection. `provider.read` verifies the
 * credential's access and reports the account; the rest list what the
 * provider's own page already lists to the owner.
 */
export function nativeOperations(
  view: Pick<NativeConnectorView, "providerId" | "configuration" | "grants">,
): string[] {
  const { providerId, configuration } = view;
  if (configuration.method === "mcp") return ["mcp.tools.list"];
  const operations = ["provider.read"];
  if (providerId === "github" || providerId === "codeberg")
    operations.push("provider.repositories.read");
  if (providerId === "s3") operations.push("provider.objects.read");
  const guilds = view.grants.some(
    (grant) => grant.actor === "user" && grant.grantedScopes.includes("guilds"),
  );
  if (providerId === "discord" && guilds)
    operations.push("provider.guilds.read");
  return operations;
}

/** Where the port reads the app's connections; replaced by a test. */
export type SessionConnectionSources = Readonly<{
  connections: () => readonly Connection[];
  native: (id: string) => NativeConnectorView | null;
  /** Whether this browser may use the connection's authorization method. */
  allowed: (view: NativeConnectorView) => boolean;
  invokeNative: (
    view: NativeConnectorView,
    operation: string,
  ) => Promise<{
    label: string;
    items: readonly { id: string; label: string; url?: string }[];
  }>;
  invokeLinear: (id: string, operation: string) => Promise<SessionResult>;
}>;

type Entry = SessionConnection &
  Readonly<{ run: (operation: string) => Promise<SessionResult> }>;

/** One line of a result: an id, a label and, if there is one, a link. */
function line(
  id: string,
  label: string,
  url?: string | null,
): SessionResult["items"][number] {
  return url ? { id, label, url } : { id, label };
}

/** Only what a device is told of a result: no schema, no stored value. */
function lines(
  items: readonly { id: string; label: string; url?: string }[],
): SessionResult["items"] {
  return items.map(({ id, label, url }) => line(id, label, url));
}

async function linearResult(
  id: string,
  operation: string,
): Promise<SessionResult> {
  if (operation === "issues.list") {
    const issues = await invokeLinearConnector(id, "issues.list");
    return {
      label: "Linear issues",
      items: lines(
        (Array.isArray(issues) ? issues : []).map((issue) =>
          "identifier" in issue
            ? line(issue.identifier, issue.title, issue.url)
            : line(issue.id, issue.id),
        ),
      ),
    };
  }
  if (operation === "projects.list") {
    const projects = await invokeLinearConnector(id, "projects.list");
    return {
      label: "Linear projects",
      items: lines(
        (Array.isArray(projects) ? projects : []).map((project) =>
          "name" in project && "url" in project
            ? line(project.id, project.name, project.url)
            : line(project.id, project.id),
        ),
      ),
    };
  }
  const teams = await invokeLinearConnector(id, "teams.list");
  return {
    label: "Linear teams",
    items: lines(
      (Array.isArray(teams) ? teams : []).map((team) => ({
        id: "key" in team ? team.key : team.id,
        label: "name" in team ? team.name : team.id,
      })),
    ),
  };
}

export const pageSessionSources: SessionConnectionSources = {
  connections: listDeviceConnections,
  native: readNativeConnector,
  allowed: (view) =>
    nativeBrowserMethodPolicy(
      view.providerId,
      view.configuration.method,
      view.configuration.parameters,
    ).available,
  invokeNative: (view, operation) =>
    nativeConnectorDriver(view.configuration.method, view.providerId).invoke(
      view.connectionId,
      operation,
      {},
    ),
  invokeLinear: linearResult,
};

/** Give up waiting on work that cannot itself be stopped. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("aborted"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function sessionConnectionPort(
  sources: SessionConnectionSources = pageSessionSources,
): ConnectionPort {
  const entries = (): Entry[] =>
    sources.connections().flatMap((connection): Entry[] => {
      const base = {
        id: connection.connectionId,
        label: connection.displayName,
        provider: connection.providerId,
      };
      const view = sources.native(connection.connectionId);
      if (view)
        return view.status === "connected" && sources.allowed(view)
          ? [
              {
                ...base,
                operations: nativeOperations(view),
                run: async (operation) => {
                  const done = await sources.invokeNative(view, operation);
                  return { label: done.label, items: lines(done.items) };
                },
              },
            ]
          : [];
      // Linear keeps its own record, not a native one.
      if (
        connection.providerId !== "linear" ||
        connection.status !== "active" ||
        isNativeDeviceConnection(connection)
      )
        return [];
      return [
        {
          ...base,
          operations: LINEAR_OPERATIONS,
          run: (operation) => sources.invokeLinear(base.id, operation),
        },
      ];
    });
  return {
    list: () => entries().map(({ run: _run, ...held }) => held),
    invoke: async ({ connection, operation, input, signal }) => {
      const entry = entries().find((held) => held.id === connection);
      // Nothing a listed operation takes needs input; anything extra is refused.
      if (
        !entry ||
        !entry.operations.includes(operation) ||
        Object.keys(input).length > 0
      )
        throw new Error("Select a supported operation");
      return untilAborted(entry.run(operation), signal);
    },
  };
}
