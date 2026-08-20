import { useState } from "react";
import { Link } from "react-router";
import { applyDaemonPairing, probeDaemon } from "../lib/daemon.js";
import { useConnect } from "../lib/identity.js";
import {
  hostStatusLabel,
  identityStatusLabel,
  needsHostPairing,
  planeSeams,
  usePlaneStatus,
} from "../lib/planes.js";
import { loadSettings, settingsSeams } from "../lib/settings.js";
import {
  assertDaemonReachableFromPage,
  detectTailnet,
  discoverTailscaleDaemon,
  openTailscaleLogin,
  waitForTailnet,
} from "../lib/tailscale.js";
import { isLoopbackUrl } from "../lib/urls.js";
import { IconAlert } from "./Icons.js";
import { QrCode } from "./QrCode.js";

function RailPlaneStatusDefault() {
  const status = usePlaneStatus();
  return (
    <p className="rail__status">
      <span
        className={`dot ${status.host === "live" || status.host === "pending" ? "dot--ok" : "dot--warn"}`}
        aria-hidden="true"
      />
      <span>{hostStatusLabel(status.host)}</span>
      <span aria-hidden="true">·</span>
      <span>{identityStatusLabel(status.identity)}</span>
    </p>
  );
}

function ConnectThisMachineDefault({
  onPaired,
}: {
  onPaired?: () => void;
}) {
  const { connect } = useConnect();
  const [daemonApi, setDaemonApi] = useState(
    () =>
      loadSettings().daemonApi ||
      (settingsSeams.pageIsLoopback() ? settingsSeams.shippedDaemonApi : ""),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const pairingUrl = daemonApi.trim();
  const canShowPairingQr = pairingUrl.length > 0 && !isLoopbackUrl(pairingUrl);

  async function finish(
    health: Awaited<ReturnType<typeof probeDaemon>>,
    via: string,
  ) {
    await applyDaemonPairing(via, health);
    setDaemonApi(health.tailscaleUrl || via);
    setMessage(
      `Paired via ${health.tailscaleUrl || via}. Host ${loadSettings().hostApi}.`,
    );
    onPaired?.();
    // Never block pairing on Identity — cross-origin /v1/principals/me used to
    // hang after the local-network permission grant with no AbortSignal.
    void connect().catch(() => {
      // Identity may still be down; daemon pairing is enough for Host plane.
    });
  }

  async function pair() {
    setBusy(true);
    setMessage(null);
    try {
      assertDaemonReachableFromPage(daemonApi);
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
      // Prefer what the operator typed — settings may still be empty.
      if (daemonApi.trim()) {
        try {
          assertDaemonReachableFromPage(daemonApi);
          const health = await probeDaemon(daemonApi);
          await finish(health, daemonApi);
          return;
        } catch {
          // Fall through to discovery / tailnet wait.
        }
      }
      try {
        const health = await discoverTailscaleDaemon(daemonApi);
        await finish(health, health.tailscaleUrl || daemonApi);
        return;
      } catch (first) {
        const onTailnet = await detectTailnet();
        if (!onTailnet) {
          openTailscaleLogin();
          setMessage(
            "Install or open the Tailscale app on this machine and sign in there. This page cannot receive a Tailscale login callback — it waits until you are on the tailnet, then pairs the daemon.",
          );
          const joined = await waitForTailnet();
          if (!joined) {
            setMessage(
              "Still not on the tailnet. Open the Tailscale app, finish sign-in, then press Connect Tailscale again.",
            );
            return;
          }
          const health = await discoverTailscaleDaemon(daemonApi);
          await finish(health, health.tailscaleUrl || daemonApi);
          return;
        }
        throw first;
      }
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
            GitHub Pages cannot see 127.0.0.1. On the daemon machine run{" "}
            <code>curl -s http://127.0.0.1:18790/health</code>. If Serve is off,
            open <code>tailscale_serve_enable_url</code>, enable Serve, restart
            the daemon, then paste <code>tailscale_url</code> (
            <code>https://machine.tailnet.ts.net</code>) here.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <div className="field">
          <label htmlFor="daemon-url">Daemon (Tailscale Serve URL)</label>
          <input
            id="daemon-url"
            type="url"
            placeholder="https://your-machine.tailnet.ts.net"
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
          {canShowPairingQr ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => setShowQr((value) => !value)}
            >
              {showQr ? "Hide QR" : "Show QR"}
            </button>
          ) : null}
        </div>
        {showQr && canShowPairingQr ? (
          <div className="conn-pair__qr">
            <QrCode
              value={pairingUrl}
              label="Scan to open this daemon Tailscale URL on another device"
              size={144}
            />
            <p className="hint">
              Scan on another device to open <code>{pairingUrl}</code>.
            </p>
          </div>
        ) : null}
        {message ? <p className="hint">{message}</p> : null}
      </div>
    </div>
  );
}

export const planeNoteSeams = {
  ConnectThisMachine: ConnectThisMachineDefault,
  PagesCannotHostNote: PagesCannotHostNoteDefault,
  RailPlaneStatus: RailPlaneStatusDefault,
};

export function ConnectThisMachine(
  props: Parameters<typeof ConnectThisMachineDefault>[0],
) {
  const Impl = planeNoteSeams.ConnectThisMachine;
  return <Impl {...props} />;
}

function PagesCannotHostNoteDefault({
  ceremony,
}: {
  ceremony: string;
}) {
  const status = usePlaneStatus();
  // Host plane is ready (or still probing a saved pairing) — do not ask again.
  if (status.host === "live" || status.host === "pending") return null;
  if (!needsHostPairing(status)) {
    if (status.host === "down") {
      return (
        <output className="note note--warn">
          <IconAlert />
          <div>
            <p>
              {ceremony} needs the Host API. {planeSeams.PAGES_CANNOT_HOST}
            </p>
            <p>
              Configured Host: <code>{status.hostBase || "none"}</code> (
              {hostStatusLabel(status.host).toLowerCase()}).{" "}
              <Link to="/settings#connectivity">Change it in Settings</Link>.
            </p>
          </div>
        </output>
      );
    }
    return null;
  }
  return <ConnectThisMachine />;
}

export function PagesCannotHostNote(
  props: Parameters<typeof PagesCannotHostNoteDefault>[0],
) {
  const Impl = planeNoteSeams.PagesCannotHostNote;
  return <Impl {...props} />;
}

export function RailPlaneStatus() {
  const Impl = planeNoteSeams.RailPlaneStatus;
  return <Impl />;
}
