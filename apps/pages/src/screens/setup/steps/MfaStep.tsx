/**
 * Step — mfa. Authenticator / email / SMS connectors (ADR 0114).
 * No question subheader — only the three connector group labels.
 */

import { ConnectorCards } from "./ConnectorCards.js";

export function MfaStep() {
  return (
    <>
      <section
        className="setup__stack"
        aria-labelledby="setup-mfa-authenticator"
      >
        <h3 id="setup-mfa-authenticator" className="setup__group-title">
          Authenticator app
        </h3>
        <ConnectorCards id="mfa_authenticator" />
      </section>

      <section className="setup__stack" aria-labelledby="setup-mfa-email">
        <h3 id="setup-mfa-email" className="setup__group-title">
          Email code
        </h3>
        <ConnectorCards id="mfa_email" />
      </section>

      <section className="setup__stack" aria-labelledby="setup-mfa-sms">
        <h3 id="setup-mfa-sms" className="setup__group-title">
          Text message
        </h3>
        <ConnectorCards id="mfa_sms" />
      </section>
    </>
  );
}
