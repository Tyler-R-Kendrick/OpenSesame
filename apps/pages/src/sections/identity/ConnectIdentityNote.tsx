import {
  normalizeSignInService,
  writeSignInService,
} from "@opensesame/app-core/lib/identity-service.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import { useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconLogin } from "../../components/Icons.js";

import { useIdentityConfigured } from "../../lib/use-configured.js";

import { useConnect } from "../../bindings/identity.js";
export function ConnectIdentityNote({
  online,
  what,
  lockIssuer = false,
}: {
  online: boolean;
  what: string;
  /** A before-unlock ceremony must not rewrite the Identity issuer mid-flight. */
  lockIssuer?: boolean;
}) {
  const { connecting, error, connect } = useConnect();
  const configured = useIdentityConfigured();
  const mayEditIssuer = !configured && !lockIssuer;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2
            title={`Manage ${what} through your organisation’s sign-in service when one is connected`}
          >
            {configured
              ? "Connect to manage identities"
              : "Connect a sign-in service"}
          </h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="actions">
          {configured ? (
            <button
              type="button"
              className="icon-btn"
              disabled={connecting || !online}
              onClick={() => void connect()}
              aria-label="Connect"
              title="Connect"
            >
              <IconLogin size={16} />
            </button>
          ) : mayEditIssuer ? (
            <IdentityAddress />
          ) : null}
        </div>
        <FailureNotice
          id="identity:connect-issuer-locked"
          title="Sign-in service"
          tone="warn"
          message={
            lockIssuer && !configured
              ? "Set your organisation’s sign-in service in Settings after you unlock this device, then open the link again."
              : null
          }
        />
        <FailureNotice
          id="identity:connect-offline"
          title="Offline"
          tone="warn"
          message={online ? null : "Offline — connecting needs the network."}
        />
        <FailureNotice
          id="identity:connect"
          title="Sign-in service"
          message={error}
        />
      </div>
    </section>
  );
}

function IdentityAddress() {
  const [value, setValue] = useState(() => loadSettings().identityApi);
  return (
    <FieldShell
      id="access-identity-api"
      label="Sign-in service"
      type="url"
      mono
      value={value}
      onValueChange={setValue}
      onCommit={(raw) => {
        const normalized = normalizeSignInService(raw);
        if (normalized) writeSignInService(normalized);
      }}
    />
  );
}
