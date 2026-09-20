import type { ComponentType } from "react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { getBundledProviders } from "../../lib/embedded-catalog.js";
import { GuideTarget, useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ConnectorMark } from "../connections/ConnectorMark.js";
import { featureBindingSections } from "../connections/page-tree.js";
import "../connections.css";
import { ActiveProjectPanel as DefaultActiveProjectPanel } from "./ActiveProjectPanel.js";
import { CoreConnectionsPanel } from "./CoreConnectionsPanel.js";
import { EndpointsPanel } from "./EndpointsPanel.js";
import { ModelProviderPanel as DefaultModelProviderPanel } from "./ModelProviderPanel.js";

/** Capability families, plus the planes and endpoints that used to be a second section. */
export function FeatureBindingsPanel({
  ActiveProjectPanel = DefaultActiveProjectPanel,
  ModelProviderPanel = DefaultModelProviderPanel,
}: {
  ActiveProjectPanel?: ComponentType;
  ModelProviderPanel?: ComponentType;
} = {}) {
  const { hash } = useLocation();
  const groups = featureBindingSections(getBundledProviders());
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hash]);
  const panelRef = useGuideTarget<HTMLElement>("settings.connectivity");
  return (
    <section className="panel" id="settings-connections" ref={panelRef}>
      <div className="panel__head">
        <h2>Connections</h2>
      </div>
      <div className="panel__body">
        <CoreConnectionsPanel />
        <EndpointsPanel />
        <ActiveProjectPanel />
        <GuideTarget id="settings.model-provider">
          <ModelProviderPanel />
        </GuideTarget>
        {groups.map((group) => (
          <div className="conn-group" key={group.id} id={group.id}>
            <h3 className="conn-group__label">{group.label}</h3>
            <ul className="conn-grid">
              {(group.items ?? []).map((item) => (
                <li className="conn-tile" key={item.id}>
                  <Link className="conn-tile__link" to={item.href}>
                    <ConnectorMark
                      providerId={item.id}
                      displayName={item.label}
                      size={32}
                    />
                    <span className="conn-tile__name">{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
