/**
 * Settings › Capabilities — providers of the always-on functions.
 *
 * Identity providers, encryption, password managers, cloud secret storage
 * and local storage belong to functions every installation has, so they
 * carry no switch. Their connectors are still configured here, beside the
 * features, so every external provider has one home (the rows Settings ›
 * Connections used to carry).
 */

import { PROVIDER_GROUPS } from "@opensesame/app-core/lib/capabilities/features.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ProviderTiles } from "./ProviderTiles.js";

export function CapabilityProviders() {
  const ref = useGuideTarget<HTMLElement>("settings.connectivity");
  return (
    <section
      className="capproviders"
      id="settings-connections"
      aria-label="Providers"
      ref={ref}
    >
      {PROVIDER_GROUPS.map((group) => (
        <div className="conn-group" key={group.category}>
          <h3 className="conn-group__label">{group.title}</h3>
          <ProviderTiles category={group.category} label={group.title} />
        </div>
      ))}
    </section>
  );
}
