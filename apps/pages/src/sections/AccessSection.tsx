import { accessViewFromLocation } from "@opensesame/app-core/lib/access-routes.js";
import { Suspense, lazy } from "react";
import { useLocation } from "react-router";
import { useIdentityConfigured } from "../lib/use-configured.js";
import { useOnline } from "../lib/use-online.js";
import { useVault } from "../lib/vault/hooks.js";
import { AccessBookPanel } from "./access/AccessBookPanel.js";
import { ConnectorsPanel } from "./access/ConnectorsPanel.js";
import { LocalAuthorityPanel } from "./access/LocalAuthorityPanel.js";
import { LocalPoliciesPanel } from "./access/LocalPoliciesPanel.js";
import { LocalRequestsPanel } from "./access/LocalRequestsPanel.js";
import { LocalResourcesPanel } from "./access/LocalResourcesPanel.js";
import { LocalSharePanel } from "./access/LocalSharePanel.js";
import { SessionsPanel } from "./access/SessionsPanel.js";
import "./access.css";

// The requests addressed to an Identity session load only where an Identity
// API is configured (ADR 0090); a deployment without one never fetches them.
const HostedRequestsPanel = lazy(() =>
  import("./access/HostedRequestsPanel.js").then((m) => ({
    default: m.HostedRequestsPanel,
  })),
);

/**
 * Access — the local PAM plane. Six tabs, one mounted at a time; every
 * list fails soft and reloads on demand. Grants, requests, sessions,
 * connectors, resources and policies all read sealed local records —
 * no backend stands behind any of them. Requests also lists what an
 * Identity session was asked, where an Identity API is configured.
 */
export function AccessSection() {
  const online = useOnline();
  const { tomb } = useVault();
  const location = useLocation();
  const tab = accessViewFromLocation(location.pathname, location.search);
  const identityConfigured = useIdentityConfigured();
  const panel = accessPanel(tab, location.hash, location.pathname);
  return (
    <>
      {panel === "access-book" ? <AccessBookPanel /> : null}
      {panel === "local-grants" ? (
        <LocalAuthorityPanel key={tomb} tomb={tomb} records="grant" />
      ) : null}
      {panel === "identity-shares" ? (
        <LocalSharePanel key={`${tomb}-shares`} tomb={tomb} />
      ) : null}
      {panel === "hosted-requests" && identityConfigured ? (
        <Suspense fallback={null}>
          <HostedRequestsPanel />
        </Suspense>
      ) : null}
      {panel === "local-requests" ||
      (panel === "hosted-requests" && !identityConfigured) ? (
        <LocalRequestsPanel tomb={tomb} />
      ) : null}
      {tab === "sessions" ? (
        <SessionsPanel key={tomb} online={online} panel={panel} />
      ) : null}
      {tab === "connectors" ? <ConnectorsPanel key={tomb} tomb={tomb} /> : null}
      {tab === "resources" ? <LocalResourcesPanel /> : null}
      {tab === "policies" ? <LocalPoliciesPanel /> : null}
    </>
  );
}

function accessFragment(hash: string, pathname: string): string {
  if (hash) return hash;
  return pathname === "/access/shares" ? "#identity-shares" : "";
}

export function accessPanel(
  view: string,
  hash: string,
  pathname = "/access",
): string {
  const target = accessFragment(hash, pathname).slice(1).split("/")[0];
  const panels = {
    grants: ["local-grants", "identity-shares", "access-book"],
    requests: ["local-requests", "hosted-requests"],
    sessions: [
      "local-sessions",
      "sent-drops",
      "local-authority-templates",
      "vault-share-sessions",
      "access-receipts",
    ],
    connectors: ["local-connectors"],
    resources: ["local-resources"],
    policies: ["local-policies"],
  };
  const choices = Object.entries(panels).find(([id]) => id === view)?.[1];
  if (
    view === "grants" &&
    (target?.startsWith("share-") || target?.startsWith("pending-"))
  )
    return "identity-shares";
  if (view === "sessions" && target?.startsWith("vault-session-"))
    return "vault-share-sessions";
  return choices?.find((id) => id === target) ?? choices?.[0] ?? "local-grants";
}
