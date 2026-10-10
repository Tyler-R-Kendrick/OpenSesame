/** Card actions describe executable routes and verified records, not catalog promises. */
import { connectPlan, isRefusedPlan } from "./connect-plan.js";
import type { Connection, Provider } from "./connections.js";
import type { NativeMethod } from "./native-connector-schema.js";
import type { NativeConnectorView } from "./native-connector-view.js";

export type ConnectorBrowserRoute = {
  method: NativeMethod | "specialized";
  /** The compiled driver AND this deployment's current browser admission permit it. */
  available: boolean;
};

export type ConnectorNativeInstall = {
  kind: "download" | "pair";
  /** A working installer or pairing destination supplied by the owning shell. */
  href: string;
  label: string;
};

export type ConnectorCardActionContext = {
  routes: readonly ConnectorBrowserRoute[];
  connection?: Pick<
    Connection,
    "providerId" | "connectionId" | "status"
  > | null;
  /** The verified projection returned by the native store, never a raw saved draft. */
  nativeView?: NativeConnectorView | null;
  /** Specialized owners must prove authorization; a saved status alone is insufficient. */
  specializedVerified?: boolean;
  /** A provider route requires an application or server outside this browser. */
  nativeRequired?: boolean;
  nativeInstall?: ConnectorNativeInstall | null;
  now: number;
};

export type ConnectorCardAction =
  | { kind: "connect"; glyph: "plus"; method: ConnectorBrowserRoute["method"] }
  | { kind: "configure"; glyph: "ellipsis"; connectionId: string }
  | { kind: "resume"; glyph: "arrow"; connectionId: string }
  | { kind: "native"; glyph: "computer"; install?: ConnectorNativeInstall }
  | { kind: "unavailable"; glyph: "blocked" };

function matchingView(
  providerId: string,
  connectionId: string,
  view: NativeConnectorView | null | undefined,
): view is NativeConnectorView {
  return (
    !!view &&
    view.providerId === providerId &&
    view.configuration.providerId === providerId &&
    view.connectionId === connectionId &&
    view.fingerprint === view.configuration.fingerprint
  );
}

function verifiedMcpResource(view: NativeConnectorView): boolean {
  if (view.configuration.method !== "mcp") return false;
  const resource = view.configuration.targetIds.mcp;
  return (
    !!resource &&
    connectPlan(view.providerId)?.methods.some(
      (method) =>
        method.kind === "mcp" &&
        method.mcp.status === "ok" &&
        method.mcp.url === view.configuration.parameters.mcp_url &&
        (method.mcp.resource ?? method.mcp.url) === resource,
    ) === true &&
    view.targets.some(
      (target) => target.kind === "mcp-resource" && target.id === resource,
    )
  );
}

function verifiedView(view: NativeConnectorView, now: number): boolean {
  const mcpResource = verifiedMcpResource(view);
  return (
    view.status === "connected" &&
    (view.configuration.method !== "mcp" || mcpResource) &&
    view.recovery.length === 0 &&
    (view.configuration.method === "native-local" ||
      mcpResource ||
      view.grants.length > 0) &&
    view.verifiedAt !== null &&
    Number.isFinite(view.verifiedAt) &&
    view.verifiedAt >= 0 &&
    Number.isFinite(now) &&
    view.grants.every(
      (grant) =>
        !grant.needsReauth &&
        (grant.expiresAt === null || grant.expiresAt > now),
    )
  );
}

const METHOD_ORDER: readonly ConnectorBrowserRoute["method"][] = [
  "oidc",
  "oauth",
  "mcp",
  "api-key",
  "native-local",
  "specialized",
];

function savedRouteAvailable(context: ConnectorCardActionContext): boolean {
  return (
    context.routes.some((route) => route.available) ||
    !!context.nativeView ||
    context.specializedVerified === true
  );
}

/** The caller supplies runtime admission, so this reducer never probes or guesses OAuth. */
export function connectorCardAction(
  provider: Pick<Provider, "id">,
  context: ConnectorCardActionContext,
): ConnectorCardAction {
  if (isRefusedPlan(provider.id))
    return { kind: "unavailable", glyph: "blocked" };
  const connection = context.connection;
  if (
    connection?.providerId === provider.id &&
    connection.status !== "revoked" &&
    savedRouteAvailable(context)
  ) {
    const view = context.nativeView;
    const verified = matchingView(provider.id, connection.connectionId, view)
      ? verifiedView(view, context.now)
      : !view && context.specializedVerified === true;
    return connection.status === "active" && verified
      ? {
          kind: "configure",
          glyph: "ellipsis",
          connectionId: connection.connectionId,
        }
      : {
          kind: "resume",
          glyph: "arrow",
          connectionId: connection.connectionId,
        };
  }
  const method = METHOD_ORDER.find((candidate) =>
    context.routes.some(
      (route) => route.method === candidate && route.available,
    ),
  );
  if (method) return { kind: "connect", glyph: "plus", method };
  const install = context.nativeInstall;
  if (install?.href.trim() && install.label.trim())
    return { kind: "native", glyph: "computer", install };
  if (context.nativeRequired) return { kind: "native", glyph: "computer" };
  return { kind: "unavailable", glyph: "blocked" };
}
