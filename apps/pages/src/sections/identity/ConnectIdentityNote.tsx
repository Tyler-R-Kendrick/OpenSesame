import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { IconAlert, IconLogin } from "../../components/Icons.js";
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
              : "Connect a sign-in service"}
          </h2>
        </div>
      </div>
      <div className="panel__body">
        <p className="hint">
          Manage {what} through your organisation’s sign-in service when one is
          connected. The vault on this device works without it.
        </p>
        {!configured ? (
          <p className="hint">
            Add the address of a sign-in service if your organisation provides
            one. Upstream providers alone are not enough for this panel.
          </p>
        ) : null}
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
        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline — connecting needs the network.
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
      hint="Saves when you leave the field; connect here to continue."
    />
  );
}
