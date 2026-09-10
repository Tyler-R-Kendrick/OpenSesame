import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { IconAlert } from "../../components/Icons.js";
import { useConnect } from "../../lib/identity.js";
import { loadSettings, saveSettings } from "../../lib/settings.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";

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
          <h2>
            {configured
              ? "Connect to manage identities"
              : "Configure your Identity service"}
          </h2>
        </div>
      </div>
      <div className="panel__body">
        <p className="hint">
          Manage {what} through your OpenSesame OIDC Identity service.
        </p>
        {!configured ? (
          <p className="hint">
            The offline vault is ready; hosting identities requires a running
            Identity API, not an upstream-provider binding.
          </p>
        ) : null}
        <div className="actions">
          {!configured ? (
            <IdentityAddress />
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={connecting || !online}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect to Identity"}
            </button>
          )}
        </div>
        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline — connecting needs the Identity service to
            answer.
          </output>
        ) : null}
        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function IdentityAddress() {
  const [value, setValue] = useState(() => loadSettings().identityApi);
  return (
    <FieldShell
      id="access-identity-api"
      label="Identity API"
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
      hint="Enter your Identity service address. Saves when you leave the field; connect here to continue."
    />
  );
}
