import {
  accessPath,
  accessViewFromLocation,
} from "@opensesame/app-core/lib/access-routes.js";
import { useState } from "react";
import { useLocation } from "react-router";
import { useOnline } from "../lib/use-online.js";
import { useVault } from "../lib/vault/hooks.js";
import { AccessBookPanel } from "./access/AccessBookPanel.js";
import { AccessPathbar } from "./access/AccessPathbar.js";
import { ACCESS_TABS, AccessTabLink } from "./access/AccessTabs.js";
import { ConnectorsPanel } from "./access/ConnectorsPanel.js";
import { LocalAuthorityPanel } from "./access/LocalAuthorityPanel.js";
import { LocalPoliciesPanel } from "./access/LocalPoliciesPanel.js";
import { LocalRequestsPanel } from "./access/LocalRequestsPanel.js";
import { LocalResourcesPanel } from "./access/LocalResourcesPanel.js";
import { LocalSharePanel } from "./access/LocalSharePanel.js";
import { SessionsPanel } from "./access/SessionsPanel.js";
import "./access.css";
import { useHashTarget } from "../lib/hash-target.js";

/**
 * Access — the local PAM plane. Six tabs, one mounted at a time; every
 * list fails soft and reloads on demand. Grants, requests, sessions,
 * connectors, resources and policies all read sealed local records —
 * no backend stands behind any of them.
 */
export function AccessSection() {
  const online = useOnline();
  const { tomb } = useVault();
  const location = useLocation();
  const tab = accessViewFromLocation(location.pathname, location.search);
  const [bookEpoch, setBookEpoch] = useState(0);
  useHashTarget();

  return (
    <div className="section__inner">
      <header className="section__head access-head">
        <h1>Access</h1>
        <AccessPathbar onImported={() => setBookEpoch((value) => value + 1)} />
      </header>

      <nav className="access-tabs" role="tablist" aria-label="Access views">
        {ACCESS_TABS.map(({ id, label, guideId }) => (
          <AccessTabLink
            key={id}
            guideId={guideId}
            label={label}
            to={accessPath(id)}
            current={tab === id}
          />
        ))}
      </nav>

      {tab === "grants" ? (
        <>
          <AccessBookPanel key={`${tomb}:${bookEpoch}`} epoch={bookEpoch} />
          <LocalAuthorityPanel key={tomb} tomb={tomb} records="grant" />
          <LocalSharePanel key={`${tomb}-shares`} tomb={tomb} />
        </>
      ) : null}
      {tab === "requests" ? <LocalRequestsPanel tomb={tomb} /> : null}
      {tab === "sessions" ? <SessionsPanel key={tomb} online={online} /> : null}
      {tab === "connectors" ? <ConnectorsPanel key={tomb} tomb={tomb} /> : null}
      {tab === "resources" ? <LocalResourcesPanel /> : null}
      {tab === "policies" ? <LocalPoliciesPanel /> : null}
    </div>
  );
}
