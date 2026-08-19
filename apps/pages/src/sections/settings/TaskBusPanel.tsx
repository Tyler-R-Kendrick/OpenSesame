import { useCallback, useEffect, useState } from "react";
import { IconAlert, IconCheck } from "../../components/Icons.js";
import {
  getTaskBusConfig,
  pingTaskBus,
  putTaskBusConfig,
  type TaskBusConfig,
} from "../../lib/taskbus.js";
import {
  ensureHostSession,
  hostLocalSessionEligible,
  useIdentitySession,
} from "../../lib/identity.js";
import { useOnline } from "../../lib/use-online.js";
import { usePlaneStatus } from "../../lib/planes.js";
import {
  taskBusControlsDisabled,
  taskBusEnvOverrideNotice,
  taskBusSaveFlash,
  taskBusPingFlash,
  taskBusStatusTone,
  taskBusShowNatsUrlField,
} from "../../lib/taskbus-panel.js";

type Flash = { tone: "ok" | "err" | "warn"; text: string };

/**
 * Configure Host TaskBus / NATS. Host dials NATS (Tailscale or loopback);
 * this tab only talks HTTPS to Host.
 */
export function TaskBusPanel() {
  const online = useOnline();
  const planes = usePlaneStatus();
  const session = useIdentitySession();
  const [config, setConfig] = useState<TaskBusConfig | null>(null);
  const [backend, setBackend] = useState<"memory" | "nats">("memory");
  const [natsUrl, setNatsUrl] = useState("nats://127.0.0.1:4222");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const refresh = useCallback(async () => {
    if (!online) return;
    try {
      if (hostLocalSessionEligible() || session) {
        await ensureHostSession().catch(() => undefined);
      }
      const next = await getTaskBusConfig();
      setConfig(next);
      setBackend(next.backend);
      if (next.natsUrl) setNatsUrl(next.natsUrl);
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not load TaskBus config",
      });
    }
  }, [online, session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onSave() {
    setBusy(true);
    setFlash(null);
    try {
      await ensureHostSession();
      const result = await putTaskBusConfig({
        backend,
        natsUrl: backend === "nats" ? natsUrl : undefined,
      });
      setConfig(result.config);
      setFlash(taskBusSaveFlash(result.applied, result.config));
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Could not save TaskBus",
      });
    } finally {
      setBusy(false);
    }
  }

  async function onPing() {
    setBusy(true);
    setFlash(null);
    try {
      await ensureHostSession();
      const result = await pingTaskBus();
      setConfig(result.config);
      setFlash(taskBusPingFlash(result.ok, result.config));
    } catch (caught) {
      setFlash({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Ping failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" id="taskbus">
      <div className="panel__head">
        <div>
          <h2>TaskBus / NATS</h2>
          <p>
            Messaging for backup wakes, webhooks, and rotation. Configure the
            URL the <strong>Host</strong> dials — e.g.{" "}
            <code>nats://your-box.tailXXXX.ts.net:4222</code>. This browser never
            opens NATS.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {!online ? (
          <p className="note">Connect to the network to configure TaskBus.</p>
        ) : planes.host !== "live" ? (
          <p className="note note--warn">
            Host API is not reachable. Pair or start Host first.
          </p>
        ) : (
          <div className="stack">
            {config ? (
              <p
                className={`note note--${taskBusStatusTone(config)}`}
              >
                {config.lastError ? <IconAlert /> : <IconCheck />} backend{" "}
                <strong>{config.backend}</strong> · source{" "}
                <strong>{config.source}</strong> · {config.status}
                {config.natsUrl ? ` · ${config.natsUrl}` : ""}
                {config.lastError ? ` · ${config.lastError}` : ""}
              </p>
            ) : null}

            <label className="field">
              Backend
              <select
                value={backend}
                onChange={(event) =>
                  setBackend(event.target.value as "memory" | "nats")
                }
                disabled={taskBusControlsDisabled(config, busy)}
              >
                <option value="memory">memory (local / tests)</option>
                <option value="nats">nats (JetStream)</option>
              </select>
            </label>

            {taskBusShowNatsUrlField(backend) ? (
              <label className="field">
                NATS URL (Host → NATS)
                <input
                  type="url"
                  value={natsUrl}
                  onChange={(event) => setNatsUrl(event.target.value)}
                  placeholder="nats://127.0.0.1:4222"
                  disabled={taskBusControlsDisabled(config, busy)}
                />
                <span className="hint">
                  Must be reachable from the Host process network (Tailscale
                  MagicDNS + port 4222 works like Host pairing).
                </span>
              </label>
            ) : null}

            {taskBusEnvOverrideNotice(config?.source ?? "default") ? (
              <p className="note note--warn">
                Host env <code>OPENSESAME_TASKBUS</code> / <code>NATS_URL</code>{" "}
                overrides stored config (Compose). Unset env to edit here.
              </p>
            ) : null}

            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={taskBusControlsDisabled(config, busy)}
                onClick={() => void onSave()}
              >
                Save
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void onPing()}
              >
                Ping from Host
              </button>
            </div>

            {flash ? (
              <p
                className={`note note--${flash.tone}`}
                role={flash.tone === "err" ? "alert" : "status"}
              >
                {flash.text}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
