import { useState } from "react";
import { Link } from "react-router";
import { applyDaemonPairing, probeDaemon } from "../lib/daemon.js";
import { useConnect } from "../lib/identity.js";
import {
  PAGES_CANNOT_HOST,
  hostStatusLabel,
  identityStatusLabel,
  usePlaneStatus,
} from "../lib/planes.js";
import {
  loadSettings,
  pageIsLoopback,
  shippedDaemonApi,
} from "../lib/settings.js";
import { IconAlert } from "./Icons.js";

export function RailPlaneStatus() {
  const status = usePlaneStatus();
  return (
    <p className="rail__status">
      <span
        className={`dot ${status.host === "live" ? "dot--ok" : "dot--warn"}`}
        aria-hidden="true"
      />
      <span>{hostStatusLabel(status.host)}</span>
      <span aria-hidden="true">·</span>
      <span>{identityStatusLabel(status.identity)}</span>
    </p>
  );
}

export function ConnectThisMachine({
  onPaired,
}: {
  onPaired?: () => void;
}) {
  const { connect } = useConnect();
  const [daemonApi, setDaemonApi] = useState(
    () => loadSettings().daemonApi || shippedDaemonApi,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pair() {
    setBusy(true);
    setMessage(null);
    try {
      const health = await probeDaemon(daemonApi);
      applyDaemonPairing(daemonApi, health);
      await connect();
      setMessage(
        `Paired ${health.service}. Host ${health.hostApi}. Identity ${health.identityApi}.`,
      );
      onPaired?.();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not reach a daemon on this machine.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel conn-pair">
      <div className="panel__head">
        <div>
          <h2>Connect this machine</h2>
          <p>
            GitHub Pages cannot host Host or Identity. Start{" "}
            <code>opensesame-daemon</code> on this computer, then pair it. Local
            Pages still auto-connects to loopback.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <div className="field">
          <label htmlFor="daemon-url">Daemon</label>
          <input
            id="daemon-url"
            type="url"
            value={daemonApi}
            onChange={(event) => setDaemonApi(event.target.value)}
          />
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void pair()}
          >
            {busy ? "Connecting…" : "Connect daemon"}
          </button>
        </div>
        {message ? <p className="hint">{message}</p> : null}
      </div>
    </div>
  );
}

export function PagesCannotHostNote({
  ceremony,
}: {
  ceremony: string;
}) {
  const status = usePlaneStatus();
  if (status.host === "live" && status.identity === "connected") return null;
  if (
    status.host === "unset" ||
    (!pageIsLoopback() && status.host === "loopback")
  ) {
    return <ConnectThisMachine />;
  }
  return (
    <output className="note note--warn">
      <IconAlert />
      <div>
        <p>
          {ceremony} needs the Host API. {PAGES_CANNOT_HOST}
        </p>
        <p>
          Configured Host: <code>{status.hostBase || "none"}</code> (
          {hostStatusLabel(status.host).toLowerCase()}).{" "}
          <Link to="/settings">Change it in Settings</Link>.
        </p>
      </div>
    </output>
  );
}
