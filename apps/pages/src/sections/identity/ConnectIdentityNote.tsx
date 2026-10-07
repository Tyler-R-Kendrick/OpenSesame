import { useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconLogin } from "../../components/Icons.js";

import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";

import { useConnect } from "../../bindings/identity.js";
export function ConnectIdentityNote({
  online,
  what,
}: {
  online: boolean;
  what: string;
}) {
  const { connecting, error, connect } = useConnect();
  const configured = useIdentityConfigured();

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
          {!configured ? (
            <IdentityAddress />
          ) : (
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
          )}
        </div>
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
      onCommit={(raw) =>
        saveSettings({
          ...loadSettings(),
          identityApi: raw.trim().replace(/\/$/, ""),
        })
      }
    />
  );
}
