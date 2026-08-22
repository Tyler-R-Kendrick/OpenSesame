import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  type DaemonHealth,
  applyDaemonPairing,
  probeDaemon,
} from "../lib/daemon.js";
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
import { FieldShell } from "./FieldShell.js";
import { IconAlert, IconCheck, IconTerminal } from "./Icons.js";
import { QrCode } from "./QrCode.js";

/**
 * Pairing this machine, as a ceremony rather than a form.
 *
 * The old panel opened with an empty URL box and three same-weight buttons —
 * Connect Tailscale, Use this URL, Show QR — and no way to tell which one was
 * yours. Discovery already knows the three places a daemon can be, so it runs
 * first and the ceremony offers exactly one action per step. Typing a tailnet
 * FQDN by hand is the least likely path and the easiest to get wrong, so it
 * lives on the failure screen with the values we do know offered as fills.
 */
type Phase = "idle" | "looking" | "found" | "paired" | "manual";

type Written = {
  daemonApi: string;
  hostApi: string;
  identityApi: string;
};

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
  autoDiscover = false,
}: {
  onPaired?: () => void;
  /** Start discovery on mount — for surfaces the operator opened deliberately. */
  autoDiscover?: boolean;
}) {
  const { connect } = useConnect();
  const [phase, setPhase] = useState<Phase>(autoDiscover ? "looking" : "idle");
  const [found, setFound] = useState<{
    health: DaemonHealth;
    via: string;
  } | null>(null);
  const [written, setWritten] = useState<Written | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [manualUrl, setManualUrl] = useState(
    () =>
      loadSettings().daemonApi ||
      (settingsSeams.pageIsLoopback() ? settingsSeams.shippedDaemonApi : ""),
  );
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
  // A discovery that resolves after the operator has moved on must not drag
  // the ceremony back to a step they left.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const finish = useCallback(
    async (health: DaemonHealth, via: string) => {
      await applyDaemonPairing(via, health);
      const saved = loadSettings();
      if (!live.current) return;
      setWritten({
        daemonApi: saved.daemonApi,
        hostApi: saved.hostApi,
        identityApi: saved.identityApi,
      });
      setPhase("paired");
      setMessage(null);
      onPaired?.();
      // Never block pairing on Identity — cross-origin /v1/principals/me used
      // to hang after the local-network permission grant with no AbortSignal.
      void connect().catch(() => {
        // Identity may still be down; daemon pairing is enough for Host plane.
      });
    },
    [connect, onPaired],
  );

  const discover = useCallback(async () => {
    setPhase("looking");
    setMessage(null);
    const saved = loadSettings().daemonApi.trim();
    try {
      // Whatever we paired with last is the likeliest answer; try it before
      // sweeping the tailnet.
      if (saved) {
        try {
          assertDaemonReachableFromPage(saved);
          const health = await probeDaemon(saved);
          if (!live.current) return;
          setFound({ health, via: health.tailscaleUrl || saved });
          setPhase("found");
          return;
        } catch {
          // Fall through to discovery.
        }
      }
      const health = await discoverTailscaleDaemon(saved);
      if (!live.current) return;
      setFound({ health, via: health.tailscaleUrl || saved });
      setPhase("found");
    } catch (first) {
      if (!live.current) return;
      const onTailnet = await detectTailnet();
      if (!live.current) return;
      if (!onTailnet) {
        openTailscaleLogin();
        setMessage(
          "Open the Tailscale app on this machine and sign in there. This page cannot receive a Tailscale login callback — it waits until you are on the tailnet, then looks again.",
        );
        const joined = await waitForTailnet();
        if (!live.current) return;
        if (joined) {
          try {
            const health = await discoverTailscaleDaemon(saved);
            if (!live.current) return;
            setFound({ health, via: health.tailscaleUrl || saved });
            setPhase("found");
            return;
          } catch (second) {
            setMessage(errorText(second));
          }
        } else {
          setMessage(
            "Still not on the tailnet. Finish sign-in in the Tailscale app, then look again.",
          );
        }
      } else {
        setMessage(errorText(first));
      }
      setPhase("manual");
    }
  }, []);

  useEffect(() => {
    if (autoDiscover) void discover();
  }, [autoDiscover, discover]);

  // Offering the clipboard is only worth it when it holds something that
  // parses as a URL — otherwise the chip is a dead end.
  useEffect(() => {
    if (phase !== "manual") return;
    if (!navigator.clipboard?.readText) return;
    let cancelled = false;
    void navigator.clipboard.readText().then(
      (text) => {
        const candidate = text.trim();
        if (cancelled || !candidate) return;
        try {
          const url = new URL(candidate);
          if (url.protocol === "http:" || url.protocol === "https:") {
            setClipboardUrl(url.origin);
          }
        } catch {
          // Not a URL — no chip.
        }
      },
      () => {
        // Permission denied or unavailable — no chip.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [phase]);

  async function pairFound() {
    if (!found) return;
    setBusy(true);
    setMessage(null);
    try {
      await finish(found.health, found.via);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  async function pairManual() {
    setBusy(true);
    setMessage(null);
    try {
      assertDaemonReachableFromPage(manualUrl);
      const health = await probeDaemon(manualUrl);
      await finish(health, manualUrl);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const pairingUrl = manualUrl.trim();
  const canShowPairingQr = pairingUrl.length > 0 && !isLoopbackUrl(pairingUrl);
  const savedDaemon = loadSettings().daemonApi.trim();
  const fills = [
    savedDaemon && savedDaemon !== manualUrl ? savedDaemon : null,
    settingsSeams.pageIsLoopback() &&
    manualUrl !== settingsSeams.shippedDaemonApi
      ? settingsSeams.shippedDaemonApi
      : null,
    clipboardUrl && clipboardUrl !== manualUrl ? clipboardUrl : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className="ceremony">
      <div className="ceremony__head">
        <h3>Connect this machine</h3>
        <p>
          {phase === "paired"
            ? "Paired. The Host and Identity endpoints came with it."
            : "This page cannot see 127.0.0.1, so it pairs your daemon over Tailscale Serve instead."}
        </p>
      </div>

      {phase === "idle" ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void discover()}
          >
            Find my daemon
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setPhase("manual")}
          >
            Enter it myself
          </button>
        </div>
      ) : null}

      {phase === "looking" ? (
        <output className="ceremony__looking">
          <span className="spin" aria-hidden="true" />
          <span>Looking for a daemon on your tailnet…</span>
        </output>
      ) : null}

      {phase === "found" && found ? (
        <>
          <div className="found">
            <p className="found__top">
              <IconCheck size={15} />
              Found on your tailnet
            </p>
            <p className="found__name">{found.via}</p>
            {/* /health is deliberately opaque, so a daemon usually does not
                state its upstreams. Showing a placeholder for them would be
                asserting ports nobody mentioned — the pairing result below
                reports what was actually written instead. */}
            {found.health.hostApi || found.health.identityApi ? (
              <dl>
                {found.health.hostApi ? (
                  <>
                    <dt>Host it fronts</dt>
                    <dd>{found.health.hostApi}</dd>
                  </>
                ) : null}
                {found.health.identityApi ? (
                  <>
                    <dt>Identity it fronts</dt>
                    <dd>{found.health.identityApi}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void pairFound()}
              >
                {busy ? "Pairing…" : "Pair this daemon"}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => setPhase("manual")}
              >
                Use a different address
              </button>
            </div>
          </div>
        </>
      ) : null}

      {phase === "paired" && written ? (
        <div className="ceremony__done">
          <span className="ceremony__done-mark" aria-hidden="true">
            <IconCheck size={24} />
          </span>
          <dl className="wrote">
            <div>
              <dt>Daemon</dt>
              <dd>{written.daemonApi || "—"}</dd>
            </div>
            <div>
              <dt>Host</dt>
              <dd>{written.hostApi || "—"}</dd>
            </div>
            <div>
              <dt>Identity</dt>
              <dd>{written.identityApi || "—"}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {phase === "manual" ? (
        <>
          <FieldShell
            id="daemon-url"
            label="Daemon (Tailscale Serve URL)"
            type="url"
            mono
            lead={<IconTerminal size={17} />}
            placeholder="https://your-machine.tailnet.ts.net"
            value={manualUrl}
            onValueChange={setManualUrl}
            fills={fills.map((value) => ({
              label: value,
              onPick: () => setManualUrl(value),
            }))}
          />
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !manualUrl.trim()}
              aria-busy={busy}
              onClick={() => void pairManual()}
            >
              {busy ? "Connecting…" : "Use this URL"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void discover()}
            >
              Look again
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
          <p className="hint">
            On the daemon machine,{" "}
            <code>curl -s http://127.0.0.1:18790/health</code> prints{" "}
            <code>tailscale_url</code>. If Serve is off it prints{" "}
            <code>tailscale_serve_enable_url</code> — open that, enable Serve,
            restart the daemon.
          </p>
        </>
      ) : null}

      {message ? <p className="hint">{message}</p> : null}
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not reach a daemon on this machine.";
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
              <Link to="/settings/connectivity">Change it in Settings</Link>.
            </p>
          </div>
        </output>
      );
    }
    return null;
  }
  return (
    <div className="panel">
      <div className="panel__body">
        <ConnectThisMachine />
      </div>
    </div>
  );
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
