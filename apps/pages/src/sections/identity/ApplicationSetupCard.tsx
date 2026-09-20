import { useState } from "react";
import {
  mappingOverridesReserved,
  previewSyntheticClaims,
} from "../../lib/configuration/claim-preview.js";
import type { LocalApplicationRegistration } from "../../lib/local-applications.js";

export function ApplicationSetupCard(props: {
  registration: LocalApplicationRegistration | undefined;
}) {
  const [test, setTest] = useState("");
  const registration = props.registration;
  const preview = previewSyntheticClaims({
    pairwiseSub: "synthetic-sub",
    scopes: registration?.scopes ?? ["openid"],
    persona: {
      name: "Ada",
      email: "ada@example.test",
      emailVerified: true,
      emailAuthoritative: true,
      orgId: registration?.organizationId,
      groups: ["operators"],
    },
    mappingOrgId: registration?.organizationId,
  });
  const callback = registration?.redirectUris[0];

  function testSignIn() {
    if (!callback || !registration?.redirectUris.includes(callback)) {
      setTest("No registered callback to test.");
      return;
    }
    window.open(callback, "_blank", "noopener,noreferrer");
    setTest(
      "Opened the registered callback. That checks connectivity, not authorization to use the app.",
    );
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h3>Setup and test</h3>
        </div>
      </div>
      <div className="panel__body">
        <p className="hint">
          This is a local browser-mediated relying party. Registration is not
          consent. OpenSesame Pages is not a SAML IdP or LDAP server. Hosted
          public PKCE and confidential clients live on your sign-in service when
          one is configured.
        </p>
        <dl>
          <dt>Authority</dt>
          <dd>client_local application registration</dd>
          <dt>Callbacks</dt>
          <dd>{registration?.redirectUris.join(", ") || "None registered."}</dd>
          <dt>Scopes</dt>
          <dd>{registration?.scopes.join(" ") || "openid"}</dd>
        </dl>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!callback}
          onClick={testSignIn}
        >
          Test sign-in
        </button>
        {test ? <p className="hint">{test}</p> : null}
        <h4>Claim preview (unsigned, synthetic)</h4>
        <pre className="cfg-source__input">
          {JSON.stringify(
            {
              sub: preview.sub,
              name: preview.name,
              email: preview.email,
              omitted: preview.omitted,
            },
            null,
            2,
          )}
        </pre>
        <p className="hint">
          Preview is not a login
          {mappingOverridesReserved({ sub: "x" })
            ? "; reserved claims such as sub cannot be mapped away."
            : "."}
        </p>
      </div>
    </section>
  );
}
