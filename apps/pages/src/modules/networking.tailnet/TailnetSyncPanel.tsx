/**
 * Settings › Vaults › Tailnet sync (ADR 0140): pair this vault with a drive
 * on the tailnet, see whether it is in step, sync now, or stop.
 *
 * Contributed by `networking.tailnet`, so it exists only while Networking is
 * on. A pairing link (`…/settings/vaults#pair-drive=<code>`, printed by
 * `opensesame daemon drive create`) fills the code in and is then dropped
 * from the address bar, so it is not left in history. In a guest session the
 * same code sets this device up from the drive instead: the vault is written
 * into this device's own place and the unlock screen asks for its password.
 */

import {
  type TailnetSyncState,
  forgetTailnetDrive,
  pairTailnetDrive,
  subscribeTailnetSync,
  syncTailnetNow,
  tailnetSyncState,
} from "@opensesame/app-core/lib/tailnet-sync/observer.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { IconConnection, IconRefresh, IconX } from "../../components/Icons.js";
import { StatusMark, type StatusTone } from "../../components/StatusMark.js";
import { type StatusMessage, StatusNote } from "../../components/StatusNote.js";
import { useVault } from "../../lib/vault/hooks.js";

const LINK_KEY = "pair-drive=";

/** Take a pairing code out of the address bar, once, and leave no trace of it. */
function takeLinkedCode(): string {
  const { hash, pathname, search } = window.location;
  const at = hash.indexOf(LINK_KEY);
  if (at === -1) return "";
  window.history.replaceState(window.history.state, "", pathname + search);
  return decodeURIComponent(hash.slice(at + LINK_KEY.length));
}

function mark(state: TailnetSyncState): { tone: StatusTone; label: string } {
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

export function TailnetSyncPanel() {
  const state = useSyncExternalStore(subscribeTailnetSync, tailnetSyncState);
  const { status, guest } = useVault();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);

  useEffect(() => {
    const linked = takeLinkedCode();
    if (linked) setCode(linked);
  }, []);

  function run(task: () => Promise<unknown>): void {
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
  }

  const drive = state.drive;
  const status_ = drive ? mark(state) : null;
  const canPair = guest || status === "unlocked" || status === "empty";

  return (
    <section className="panel" id="tailnet-sync">
      <div className="panel__head">
        <div>
          <h2>Tailnet sync</h2>
        </div>
        {status_ ? (
          <StatusMark tone={status_.tone} label={status_.label} />
        ) : null}
      </div>
      <div className="panel__body">
        {drive ? (
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
              onClick={() => run(syncTailnetNow)}
            >
              <IconRefresh size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Stop syncing this vault"
              title="Stop syncing this vault"
              disabled={busy}
              onClick={() => run(forgetTailnetDrive)}
            >
              <IconX size={16} />
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const pasted = code;
              run(async () => {
                await pairTailnetDrive(pasted);
                setCode("");
              });
            }}
          >
            <label htmlFor="tailnet-sync-code">Pairing code</label>
            <div className="field-inline">
              <input
                id="tailnet-sync-code"
                type="text"
                value={code}
                placeholder="opensesame-drive:v1:…"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy || !canPair}
                onChange={(event) => {
                  setCode(event.target.value);
                  setMessage(null);
                }}
              />
              <button
                type="submit"
                className="icon-btn"
                disabled={busy || !canPair || code.trim().length === 0}
                aria-label={
                  guest
                    ? "Set this device up from the drive"
                    : "Pair with this drive"
                }
                title={
                  guest
                    ? "Set this device up from the drive"
                    : "Pair with this drive"
                }
              >
                <IconConnection size={16} />
              </button>
            </div>
          </form>
        )}
        <StatusNote message={message} onDismiss={() => setMessage(null)} />
      </div>
    </section>
  );
}
