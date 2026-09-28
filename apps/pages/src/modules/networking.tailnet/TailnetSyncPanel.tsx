/**
 * Settings › Vaults › Tailnet sync (ADR 0144): pair this vault with a drive
 * on the tailnet, see whether it is in step, sync now, or stop.
 *
 * Contributed by `networking.tailnet`, so it exists only while Networking is
 * on. Pairing is a ceremony in a sheet (`TailnetPairSheet`), never a field
 * on the page. A pairing link (`…/settings/vaults#pair-drive=<code>`, printed
 * by `opensesame daemon drive create`) opens it with the code filled in; boot
 * has already taken the code out of the address bar (`lib/pairing-link.ts`).
 */

import {
  type TailnetSyncState,
  forgetTailnetDrive,
  pairTailnetDrive,
  subscribeTailnetSync,
  syncTailnetNow,
  tailnetSyncState,
} from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconConnection, IconRefresh, IconX } from "../../components/Icons.js";
import { StatusMark, type StatusTone } from "../../components/StatusMark.js";
import { type StatusMessage, StatusNote } from "../../components/StatusNote.js";
import {
  subscribeLinkedPairing,
  takeLinkedPairing,
} from "../../lib/pairing-link.js";
import { useVault } from "../../lib/vault/hooks.js";
import { CeremonyRow } from "../../sections/settings/CeremonyRow.js";
import { GuideTarget } from "../../tutorial/registry/react.jsx";
import { TailnetPairSheet } from "./TailnetPairSheet.js";

/**
 * The observer this panel reads and drives. A seam, so a test can stand in
 * for the drive without replacing the module.
 */
export type TailnetPanelSeams = {
  state: () => TailnetSyncState;
  subscribe: (listener: () => void) => () => void;
  pair: (code: string) => Promise<"paired" | "adopted">;
  sync: () => Promise<void>;
  forget: () => Promise<void>;
};

export const tailnetPanelSeams: TailnetPanelSeams = {
  state: tailnetSyncState,
  subscribe: subscribeTailnetSync,
  pair: pairTailnetDrive,
  sync: syncTailnetNow,
  forget: forgetTailnetDrive,
};

/** The panel head's glyph: a tone and the sentence it stands for. */
type Standing = { tone: StatusTone; label: string };

function mark(state: TailnetSyncState): Standing {
  if (state.phase === "syncing") return { tone: "idle", label: "Syncing" };
  if (state.phase === "error") {
    return { tone: "err", label: state.error ?? "Sync failed" };
  }
  if (state.lastSyncedAt) {
    const at = new Date(state.lastSyncedAt).toLocaleTimeString();
    return { tone: "ok", label: `In step at ${at}` };
  }
  return { tone: "idle", label: "Waiting for the first sync" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Run = (task: () => Promise<void>) => void;

function DriveRow({
  state,
  busy,
  run,
}: {
  state: TailnetSyncState & { drive: { label: string; url: string } };
  busy: boolean;
  run: Run;
}) {
  const { drive } = state;
  return (
    <div className="vault-row">
      <div className="vault-row__body">
        <span className="vault-row__mark" aria-hidden="true">
          <IconConnection size={18} />
        </span>
        <span className="vault-row__text">
          <span className="vault-row__name">
            {drive.label || hostOf(drive.url)}
          </span>
          <span className="vault-row__meta">{hostOf(drive.url)}</span>
        </span>
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label="Sync now"
        title="Sync now"
        disabled={busy || state.phase === "syncing"}
        onClick={() => run(tailnetPanelSeams.sync)}
      >
        <IconRefresh size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Stop syncing this vault"
        title="Stop syncing this vault"
        disabled={busy}
        onClick={() => run(tailnetPanelSeams.forget)}
      >
        <IconX size={16} />
      </button>
    </div>
  );
}

/** A pairing link the boot took from the address bar opens the ceremony. */
function useLinkedPairing(open: (code: string) => void) {
  useEffect(() => {
    const take = () => {
      const linked = takeLinkedPairing();
      if (linked) open(linked);
    };
    take();
    return subscribeLinkedPairing(take);
  }, [open]);
}

export function TailnetSyncPanel() {
  const state = useSyncExternalStore(
    tailnetPanelSeams.subscribe,
    tailnetPanelSeams.state,
  );
  const { status, guest } = useVault();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [pairing, setPairing] = useState<{ code: string } | null>(null);
  const canPair = guest || status === "unlocked" || status === "empty";
  useLinkedPairing(useCallback((code) => setPairing({ code }), []));

  const run: Run = (task) => {
    setMessage(null);
    setBusy(true);
    void task()
      .catch((caught) =>
        setMessage({
          tone: "err",
          text: caught instanceof Error ? caught.message : String(caught),
        }),
      )
      .finally(() => setBusy(false));
  };

  const { drive } = state;
  const standing = drive ? mark(state) : null;

  return (
    <GuideTarget id="settings.tailnet-sync">
      <section className="panel set__security" id="tailnet-sync">
        <div className="panel__head">
          <div>
            <h2>Tailnet sync</h2>
          </div>
          {standing ? (
            <StatusMark tone={standing.tone} label={standing.label} />
          ) : null}
        </div>
        <div className="panel__body">
          {drive ? (
            <DriveRow state={{ ...state, drive }} busy={busy} run={run} />
          ) : (
            <CeremonyRow
              icon={<IconConnection size={16} />}
              label="Drive on your tailnet"
              sub="Not paired"
              action={
                <IconKey
                  small
                  label={
                    guest
                      ? "Set this device up from the drive"
                      : "Pair with a drive"
                  }
                  disabled={busy || !canPair}
                  aria-haspopup="dialog"
                  onClick={() => setPairing({ code: "" })}
                >
                  <IconConnection size={16} />
                </IconKey>
              }
            />
          )}
          <StatusNote message={message} onDismiss={() => setMessage(null)} />
        </div>
        {pairing ? (
          <TailnetPairSheet
            initialCode={pairing.code}
            guest={guest}
            canPair={canPair}
            onPair={async (code) => {
              await tailnetPanelSeams.pair(code);
              setPairing(null);
              // The row that opened the sheet is now the drive's row.
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>(
                    '#tailnet-sync [aria-label="Sync now"]',
                  )
                  ?.focus(),
              );
            }}
            onClose={() => setPairing(null)}
          />
        ) : null}
      </section>
    </GuideTarget>
  );
}
