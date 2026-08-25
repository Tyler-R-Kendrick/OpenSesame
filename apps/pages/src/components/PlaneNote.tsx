import { briefOrigin } from "@opensesame/os-domain";
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
import { type CeremonyAlt, CeremonyShell } from "./CeremonyShell.js";
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
  const [manualUrl, setManualUrl] = useState(
    () =>
      loadSettings().daemonApi ||
      (settingsSeams.pageIsLoopback() ? settingsSeams.shippedDaemonApi : ""),
  );
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
  const savedDaemon = loadSettings().daemonApi.trim();

  // The same alternatives on every step, as rows that expand in place. They
  // used to be a changing row of side-by-side buttons — "Enter it myself",
  // "Use a different address", "Show QR" — that renamed themselves per phase,
  // which is exactly the which-button-is-for-me problem the ceremony shape
  // exists to remove.
  const manualAlt: CeremonyAlt = {
    id: "manual",
    label: "Paste a Serve URL instead",
    icon: <IconTerminal size={18} />,
    render: () => (
      <>
        <ManualUrlField value={manualUrl} onChange={setManualUrl} />
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void pairManual()}
          >
            {busy ? "Connecting…" : "Use this URL"}
          </button>
        </div>
      </>
    ),
  };
  const qrAlt: CeremonyAlt = {
    id: "qr",
    label: "Scan a QR on another device",
    icon: <IconTerminal size={18} />,
    render: () =>
      pairingUrl && !isLoopbackUrl(pairingUrl) ? (
        <div className="qr-block">
          <QrCode
            value={pairingUrl}
            label="Scan to open this daemon Tailscale URL on another device"
            size={144}
          />
          <p className="hint">
            Scan on another device to open <code>{pairingUrl}</code>.
          </p>
        </div>
      ) : (
        <p className="hint">
          Enter a non-loopback Serve URL first — a QR of 127.0.0.1 would open
          the scanning device's own loopback, not this machine.
        </p>
      ),
  };

  const fronts = found
    ? [
        ...(found.health.hostApi
          ? [{ key: "Host it fronts", value: found.health.hostApi }]
          : []),
        ...(found.health.identityApi
          ? [{ key: "Identity it fronts", value: found.health.identityApi }]
          : []),
      ]
    : [];

  return (
    // No heading of its own: this only ever renders inside the connection
    // sheet, whose head already names the connector and carries the lead.
    // The machine ceremony was the one of five that painted a second title
    // under the first.
    <div className="ceremony">
      {phase === "idle" ? (
        <CeremonyShell
          ok={false}
          top="Not paired"
          name={savedDaemon ? briefOrigin(savedDaemon) : "No daemon connected"}
          primary={{
            label: "Find my daemon",
            onClick: () => void discover(),
          }}
          alts={[manualAlt, qrAlt]}
        />
      ) : null}

      {phase === "looking" ? (
        <output className="ceremony__looking">
          <span className="spin" aria-hidden="true" />
          <span>Looking for a daemon on your tailnet…</span>
        </output>
      ) : null}

      {phase === "found" && found ? (
        <CeremonyShell
          ok
          top="Found on your tailnet"
          name={found.via}
          // /health is deliberately opaque, so a daemon usually does not
          // state its upstreams. Showing a placeholder for them would be
          // asserting ports nobody mentioned — the pairing result below
          // reports what was actually written instead.
          facts={fronts}
          primary={{
            label: busy ? "Pairing…" : "Pair this daemon",
            onClick: () => void pairFound(),
            busy,
          }}
          alts={[manualAlt, qrAlt]}
        />
      ) : null}

      {phase === "paired" && written ? (
        <div className="ceremony__done">
          <span className="ceremony__done-mark" aria-hidden="true">
            <IconCheck size={24} />
          </span>
          <p className="hint">
            Paired. The Host and Identity endpoints came with it.
          </p>
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
        <CeremonyShell
          ok={false}
          top="Nothing paired yet"
          // The field is the card here, not an alternative: on the
          // nothing-found path typing the URL *is* the primary action, which
          // is exactly how the canvas draws the empty state.
          name="Enter the Serve URL yourself"
          primary={{
            label: busy ? "Connecting…" : "Use this URL",
            onClick: () => void pairManual(),
            busy,
          }}
          secondary={{
            label: "Look again",
            onClick: () => void discover(),
            disabled: busy,
          }}
          alts={[qrAlt]}
        >
          <ManualUrlField value={manualUrl} onChange={setManualUrl} />
          <p className="hint">
            On the daemon machine,{" "}
            <code>curl -s http://127.0.0.1:18790/health</code> prints{" "}
            <code>tailscale_url</code>. If Serve is off it prints{" "}
            <code>tailscale_serve_enable_url</code> — open that, enable Serve,
            restart the daemon.
          </p>
        </CeremonyShell>
      ) : null}

      {message ? <p className="hint">{message}</p> : null}
    </div>
  );
}

/**
 * The Serve URL field, with its fill chips.
 *
 * Clipboard is read on mount rather than on a phase flag: this field now
 * appears both as the manual card and inside an alternative row, and "it just
 * became visible" is the one moment a clipboard suggestion is worth offering.
 */
function ManualUrlField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);

  // Offering the clipboard is only worth it when it holds something that
  // parses as a URL — otherwise the chip is a dead end.
  useEffect(() => {
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
  }, []);

  const savedDaemon = loadSettings().daemonApi.trim();
  const fills = [
    savedDaemon && savedDaemon !== value ? savedDaemon : null,
    settingsSeams.pageIsLoopback() && value !== settingsSeams.shippedDaemonApi
      ? settingsSeams.shippedDaemonApi
      : null,
    clipboardUrl && clipboardUrl !== value ? clipboardUrl : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <FieldShell
      id="daemon-url"
      label="Daemon (Tailscale Serve URL)"
      type="url"
      mono
      lead={<IconTerminal size={17} />}
      placeholder="https://your-machine.tailnet.ts.net"
      value={value}
      onValueChange={onChange}
      fills={fills.map((entry) => ({
        label: entry,
        onPick: () => onChange(entry),
      }))}
    />
  );
}

function errorText<Thrown>(error: Thrown): string {
  return error instanceof Error
    ? error.message
    : "Could not reach a daemon on this machine.";
}

export const planeNoteSeams = {
  ConnectThisMachine: ConnectThisMachineDefault,
  RailPlaneStatus: RailPlaneStatusDefault,
};

export function ConnectThisMachine(
  props: Parameters<typeof ConnectThisMachineDefault>[0],
) {
  const Impl = planeNoteSeams.ConnectThisMachine;
  return <Impl {...props} />;
}

export function RailPlaneStatus() {
  const Impl = planeNoteSeams.RailPlaneStatus;
  return <Impl />;
}
