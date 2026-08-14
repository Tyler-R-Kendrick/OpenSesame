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
import {
  detectTailnet,
  discoverTailscaleDaemon,
  openTailscaleLogin,
} from "../lib/tailscale.js";
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

  async function finish(
    health: Awaited<ReturnType<typeof probeDaemon>>,
    via: string,
  ) {
    applyDaemonPairing(via, health);
    setDaemonApi(health.tailscaleUrl || via);
    try {
      await connect();
    } catch {
      // Identity may still be down; pairing the daemon is enough to stop guessing loopback.
    }
    setMessage(
      `Paired via ${health.tailscaleUrl || via}. Host ${health.hostApi}.`,
    );
    onPaired?.();
  }

  async function pair() {
    setBusy(true);
    setMessage(null);
    try {
      const health = await probeDaemon(daemonApi);
      await finish(health, daemonApi);
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

  async function pairTailscale() {
    setBusy(true);
    setMessage(null);
    try {
      const onTailnet = await detectTailnet();
      if (!onTailnet) {
        openTailscaleLogin();
        setMessage(
          "This browser is not on your tailnet. Connect Tailscale, then press the button again.",
        );
        return;
      }
      const health = await discoverTailscaleDaemon();
      await finish(health, health.tailscaleUrl || daemonApi);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not discover a daemon on the tailnet.",
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
            GitHub Pages cannot see 127.0.0.1. Connect Tailscale on this
            browser, then this page finds the daemon through the tailnet
            passthrough.
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
            onClick={() => void pairTailscale()}
          >
            {busy ? "Connecting…" : "Connect Tailscale"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void pair()}
          >
            Use this URL
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
