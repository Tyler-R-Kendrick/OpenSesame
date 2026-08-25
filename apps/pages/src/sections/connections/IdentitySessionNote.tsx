import { IconClock, IconLock } from "../../components/Icons.js";
import {
  hostLocalSessionEligible,
  useConnect,
  useIdentitySession,
} from "../../lib/identity.js";
import { shouldAutoConnect } from "../../lib/settings.js";
import { useOnline } from "../../lib/use-online.js";

/** Shown while the Identity session that backs Host authorization is absent. */
export function IdentitySessionNote() {
  const session = useIdentitySession();
  const { connecting, error, connect } = useConnect();
  const online = useOnline();
  if (hostLocalSessionEligible()) return null;
  if (session) return null;
  if (!shouldAutoConnect() && !connecting && !error) return null;
  return (
    <div className="note note--warn conn-session-note">
      <IconLock />
      <div>
        <p>
          {error
            ? "OpenSesame Identity is unreachable, so Host connectors cannot authorize yet. Vault logins, passkeys, and import still work on this device."
            : "Starting your OpenSesame session so Host connectors can authorize. Vault items on this identity stay available either way."}
        </p>
        {error ? (
          <>
            <p>{error}</p>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void connect()}
              disabled={connecting || !online}
            >
              {connecting ? "Connecting…" : "Try Identity again"}
            </button>
          </>
        ) : connecting ? (
          <p className="hint conn-connecting">
            <IconClock /> Establishing your private session…
          </p>
        ) : null}
      </div>
    </div>
  );
}
