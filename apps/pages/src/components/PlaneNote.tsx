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
  assertDaemonReachableFromPage,
  detectTailnet,
  discoverTailscaleDaemon,
  openTailscaleLogin,
  waitForTailnet,
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
    () => loadSettings().daemonApi || (pageIsLoopback() ? shippedDaemonApi : ""),
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
      // Prefer discovery first — detectTailnet can lag behind a working Serve URL.
      try {
        const health = await discoverTailscaleDaemon();
        await finish(health, health.tailscaleUrl || daemonApi);
        return;
      } catch (first) {
        // If the operator already pasted a Serve URL, try that before install/wait.
        if (daemonApi.trim()) {
          try {
            assertDaemonReachableFromPage(daemonApi);
            const health = await probeDaemon(daemonApi);
            await finish(health, daemonApi);
            return;
          } catch {
            // Fall through.
          }
        }
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
          const health = await discoverTailscaleDaemon();
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
            GitHub Pages cannot see 127.0.0.1. Paste your daemon&apos;s Tailscale
            Serve URL (<code>https://machine.tailnet.ts.net</code>), which you
            get from{" "}
            <code>curl -s http://127.0.0.1:18790/health</code> on the daemon
            host (<code>tailscale_url</code>). Bare MagicDNS HTTPS names and
            localhost will not work from this page.
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
