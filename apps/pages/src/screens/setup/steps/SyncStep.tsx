/**
 * Step — sync. Cloud secret storage and password managers (ADR 0114).
 */

import { ConnectorCards } from "./ConnectorCards.js";

export function SyncStep() {
  return (
    <>
      <section
        className="setup__stack"
        aria-labelledby="setup-sync-cloud-secrets"
      >
        <h3 id="setup-sync-cloud-secrets" className="setup__group-title">
          Cloud secret storage
        </h3>
        <ConnectorCards id="cloud_secrets" />
      </section>

      <section
        className="setup__stack"
        aria-labelledby="setup-sync-password-managers"
      >
        <h3 id="setup-sync-password-managers" className="setup__group-title">
          Password managers
        </h3>
        <ConnectorCards id="password_managers" />
      </section>
    </>
  );
}
