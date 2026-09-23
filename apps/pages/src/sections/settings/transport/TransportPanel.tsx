import { toTransportViewState } from "@opensesame/app-core/lib/transport-rows.js";
import {
  DEFAULT_TRANSPORT_TARGET,
  type TransportTargetSettings,
  loadTransportSettings,
  saveTransportSettings,
  subscribeTransportSettings,
  transportSettingsEpoch,
  transportTargetNames,
  transportTargetSettings,
  withTransportTarget,
} from "@opensesame/app-core/lib/transport-settings.js";
import {
  type TransportStatusResult,
  lastTransportStatus,
  readTransportStatus,
} from "@opensesame/app-core/lib/transport-status.js";
import { runTransportVerify } from "@opensesame/app-core/lib/transport-verify.js";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { IconRefresh, IconShield } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { TransportBrowserRow } from "./TransportBrowserRow.js";
import { TransportStatusRows } from "./TransportStatusRows.js";
import { TransportTargetForm } from "./TransportTargetForm.js";
import "./transport.css";

import { useTransportVerifierConfigured } from "../../../bindings/transport.js";
/**
 * Settings › Security › Transport.
 *
 * Desired policy on this device, then what the endpoint reports — credential,
 * runtime, observed authentication, enforcement — one row each. Status is
 * read when the panel opens and when its key is pressed, and only when an
 * endpoint is set; a fresh origin asks nothing and reports nothing failed.
 * Verification is the endpoint's own probe and is offered only where there is
 * one to ask. A stale answer is a glyph, never a wall.
 */
export function TransportPanel() {
  useSyncExternalStore(
    subscribeTransportSettings,
    transportSettingsEpoch,
    transportSettingsEpoch,
  );
  const configured = useTransportVerifierConfigured();
  const panelRef = useGuideTarget<HTMLElement>("settings.transport");
  const [target, setTarget] = useState(DEFAULT_TRANSPORT_TARGET);
  const [status, setStatus] = useState<TransportStatusResult | null>(
    lastTransportStatus,
  );
  const [busy, setBusy] = useState(false);
  const block = loadTransportSettings();
  const targets = transportTargetNames(block);
  const current = transportTargetSettings(block, target);

  const run = useCallback(
    async (action: () => Promise<TransportStatusResult>) => {
      setBusy(true);
      try {
        setStatus(await action());
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // Panel open, endpoint set: read once. Never on launch, never unconfigured.
  useEffect(() => {
    if (configured && lastTransportStatus() === null)
      void run(readTransportStatus);
  }, [configured, run]);

  const commit = (next: TransportTargetSettings) => {
    saveTransportSettings(withTransportTarget(block, target, next));
  };

  const view = toTransportViewState(status, current.desiredPolicy);

  return (
    <section
      ref={panelRef}
      className="panel set__security transport"
      id="transport"
      aria-labelledby="transport-title"
      data-stale={view.stale ? "true" : "false"}
    >
      <div className="panel__head">
        <div className="transport__title">
          <h2 id="transport-title">Transport</h2>
          {view.stale ? (
            <StatusMark
              tone="warn"
              label="Stale: verified against an earlier generation"
            />
          ) : null}
        </div>
        <div className="actions">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Refresh transport status"
            title="Refresh transport status"
            disabled={busy}
            onClick={() => void run(readTransportStatus)}
          >
            <IconRefresh size={16} />
          </button>
          {configured ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Run enforcement verification at the endpoint"
              title="Run enforcement verification at the endpoint"
              disabled={busy}
              onClick={() => void run(runTransportVerify)}
            >
              <IconShield size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel__body">
        <TransportTargetForm
          target={target}
          targets={targets}
          settings={current}
          onTarget={setTarget}
          onChange={commit}
        />
        <TransportStatusRows view={view} />
        {current.browserProfile ? (
          <TransportBrowserRow profile={current.browserProfile} />
        ) : null}
      </div>
    </section>
  );
}
