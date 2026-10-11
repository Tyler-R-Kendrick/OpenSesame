/**
 * Settings › Integrations — what this installation connects to.
 *
 * One list of sections (`IntegrationSections`), each a feature's third-party
 * services: an identity provider, a key service, a forge to back up to, a
 * password manager, a secret store, a payment provider, an agent harness, a
 * tailnet. A connector is configured by reference on its own page, so nothing
 * here is switched, reviewed or waits on a feature being on (ADR 0188). The
 * switches are Settings › Features.
 */

import { IntegrationSections } from "./IntegrationSections.js";
import "./capabilities.css";

export function IntegrationsPanel() {
  return (
    <section className="panel" data-testid="integrations-panel">
      <div className="panel__head capspanel__head">
        <h2>Integrations</h2>
      </div>
      <div className="panel__body capspanel">
        <IntegrationSections />
      </div>
    </section>
  );
}
