import { useState } from "react";
import { BrowserPairingCeremony } from "../../components/BrowserPairingCeremony.js";
import { HostAuthorizationCeremony } from "../../components/HostAuthorizationCeremony.js";
import { HostAddress } from "../../components/HostCeremony.js";
import { mayPairLocalAuthority } from "../../lib/deployment-profile.js";
import { hostBase } from "../../lib/identity.js";

/** Reuse the same endpoint, pairing and verified-user ceremonies as Settings. */
export function AccessAuthority({ onChanged }: { onChanged: () => void }) {
  const [mode, setMode] = useState<"closed" | "address" | "pair" | "verify">(
    "closed",
  );
  const host = hostBase();
  const eligible = mayPairLocalAuthority();
  return (
    <>
      <div className="actions">
        <button
          type="button"
          className="btn btn--sm"
          aria-expanded={mode !== "closed"}
          onClick={() => setMode(mode === "closed" ? "address" : "closed")}
        >
          {host ? "Manage Host access" : "Connect Host"}
        </button>
      </div>
      {mode === "address" ? (
        <section className="panel">
          <div className="panel__body">
            <HostAddress />
            {!eligible ? (
              <p className="hint">
                This restricted demo cannot pair with authority; use a
                dedicated-origin or loopback build.
              </p>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={!host || !eligible}
                onClick={() => setMode("pair")}
              >
                Pair browser
              </button>
              <button
                type="button"
                className="btn"
                disabled={!host || !eligible}
                onClick={() => setMode("verify")}
              >
                Verify Identity for Host access
              </button>
            </div>
          </div>
        </section>
      ) : null}
      {mode === "pair" ? (
        <BrowserPairingCeremony
          hostApi={host}
          onCancel={() => setMode("address")}
          onComplete={() => {
            setMode("verify");
            onChanged();
          }}
        />
      ) : null}
      {mode === "verify" ? (
        <HostAuthorizationCeremony
          onCancel={() => setMode("address")}
          onComplete={() => {
            setMode("closed");
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}
