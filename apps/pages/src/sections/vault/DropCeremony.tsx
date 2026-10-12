import { useEffect, useState } from "react";
/**
 * Drop ceremonies (docs/design/secret-drop.md §3/§4/§5).
 *
 * - `ShareSecretDrop`: the share ceremony on any stored item — TTL, seal,
 *   drop card. The item itself is not modified and no drop item is saved.
 * - `DropRecordFields`: a legacy drop record's detail — state, countdown, the
 *   kept copy if there is one — and the disposal poll that purges the record
 *   once nothing can open the drop again.
 *
 * In every flow the plaintext is never shown again after sealing: the drop
 * card carries the link, the user code, the window that was sealed, the time
 * it lapses, and the QR. A seal that fails is a tray notice, never a box.
 */

import { isDeviceIdentityMode } from "@opensesame/app-core/lib/device-identity.js";
import {
  type SharedOnce,
  shareOnce,
  sweepDrop,
} from "@opensesame/app-core/lib/vault/drop.js";
import { shareText } from "@opensesame/app-core/sections/vault-section-model.js";
import {
  type DropItem,
  type VaultItem,
  b64ToBytes,
} from "@opensesame/vault-core";
import { FailureNotice } from "../../components/FailureNotice.js";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconKey } from "../../components/IconKey.js";
import { IconDownload } from "../../components/Icons.js";
import { QrCode } from "../../components/QrCode.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { DROP_TTL_OPTIONS, dropTtlLabel } from "./DropTtl.js";
import { ShareForm } from "./ShareForm.js";
import { formatExpiry } from "./expiry.js";

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** When `expiresAt` lapses, plus what is left while it is still ahead. */
export function clockExpiry(expiresAt: string, now: number): string {
  const remaining = Date.parse(expiresAt) - now;
  const when = formatExpiry(expiresAt);
  if (!Number.isFinite(remaining) || remaining <= 0) return when;
  return `${when} · ${formatRemaining(remaining)}`;
}

/** What a finished ceremony shows: link, code, the sealed expiry, QR — never the payload. */
export function DropCard({
  drop,
  opensFor,
  now,
}: {
  drop: SharedOnce;
  /** The TTL the person sealed, from the choices the form offers. */
  opensFor: string;
  now: number;
}) {
  const { copied, failed, copy } = useCopyFeedback();
  return (
    <section className="detail__group" aria-label="Drop ready">
      <h2 className="detail__grouphead">Drop ready</h2>
      <FieldRow
        label="Link"
        actions={
          <CopyButton
            value={drop.link}
            label="drop link"
            fieldKey="drop-link"
            copied={copied}
            failed={failed}
            onCopy={copy}
          />
        }
      >
        <span className="frow__value frow__value--mono drop-card__link">
          {drop.link}
        </span>
      </FieldRow>
      <FieldRow
        label="User code"
        actions={
          <CopyButton
            value={drop.userCode}
            label="user code"
            fieldKey="drop-code"
            copied={copied}
            failed={failed}
            onCopy={copy}
          />
        }
      >
        <span className="frow__value frow__value--mono">{drop.userCode}</span>
      </FieldRow>
      {opensFor !== "" ? (
        <FieldRow label="Opens for">
          <span className="frow__value">{opensFor}</span>
        </FieldRow>
      ) : null}
      {isDeviceIdentityMode() ? (
        <FieldRow label="Opens on">
          <span className="frow__value">This browser</span>
        </FieldRow>
      ) : null}
      <FieldRow label="Expires">
        <span className="frow__value">{clockExpiry(drop.expiresAt, now)}</span>
      </FieldRow>
      <div className="drop-card__qr">
        <QrCode value={drop.link} label="Scan to open this drop" size={144} />
      </div>
    </section>
  );
}

/**
 * Share ceremony on a stored item, drawn while the toolbar's Share key is
 * pressed. The item is untouched. Closing it, by the key or Cancel, forgets a
 * finished drop's card, so the next press starts a new share.
 */
export function ShareSecretDrop({
  item,
  open,
  onClose,
}: {
  item: VaultItem;
  open: boolean;
  onClose: () => void;
}) {
  const text = shareText(item);
  const now = useNow();
  const [ttlMs, setTtlMs] = useState<number>(DROP_TTL_OPTIONS[1].ms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drop, setDrop] = useState<SharedOnce | null>(null);

  useEffect(() => {
    if (open) return;
    setDrop(null);
    setError(null);
  }, [open]);

  async function share() {
    if (text === null) return;
    setBusy(true);
    setError(null);
    try {
      const name = item.name || "Shared item";
      setDrop(await shareOnce({ name, text, ttlMs, sourceItemId: item.id }));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The drop could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (text === null || !open) return null;

  if (drop) {
    return <DropCard drop={drop} opensFor={dropTtlLabel(ttlMs)} now={now} />;
  }

  return (
    <>
      <FailureNotice
        id={`vault:drop:${item.id}`}
        title="Drop"
        message={error}
      />
      <ShareForm
        ttlMs={ttlMs}
        onTtl={setTtlMs}
        expiry={clockExpiry(new Date(now + ttlMs).toISOString(), now)}
        busy={busy}
        onSeal={() => void share()}
        onCancel={onClose}
      />
    </>
  );
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
}

function downloadKeptFile(copy: {
  name: string;
  contentType: string;
  dataB64: string;
}): void {
  const bytes = b64ToBytes(copy.dataB64);
  // SAFETY: Blob accepts a typed array view; bytes is a fresh local buffer.
  const blob = new Blob([bytes], { type: copy.contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = copy.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Drop record detail: state, countdown, optional kept copy, disposal poll. */
/** The drop kind's record view (`item-kind` contribution). */
export function DropRecord({ item }: { item: VaultItem }) {
  return item.kind === "drop" ? <DropRecordFields item={item} /> : null;
}

export function DropRecordFields({ item }: { item: DropItem }) {
  const store = useVaultStore();
  const now = useNow();
  const [revealed, setRevealed] = useState(false);
  const { copied, failed, copy } = useCopyFeedback();
  const kept = item.keptCopy;

  // Disposal: poll once per viewing; a terminal claim purges the record, and
  // so does the TTL lapsing while this page is open.
  useEffect(() => {
    void sweepDrop(item, () => store.purgeItem(item.id));
  }, [item, store]);

  const remaining = Date.parse(item.expiresAt) - now;
  const stateLabel =
    item.state === "pending"
      ? "Waiting to be opened"
      : item.state === "consumed"
        ? "Opened"
        : "Expired";

  return (
    <>
      <section className="detail__group">
        <h2 className="detail__grouphead">Drop</h2>
        <FieldRow label="State">
          <span className="frow__value">{stateLabel}</span>
        </FieldRow>
        <FieldRow label="Opens until">
          <span className="frow__value">
            {formatExpiry(item.expiresAt)}
            {item.state === "pending" && remaining > 0
              ? ` · ${formatRemaining(remaining)}`
              : ""}
          </span>
        </FieldRow>
      </section>

      {kept ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Kept copy</h2>
          {kept.kind === "text" ? (
            <FieldRow
              label="Text"
              actions={
                <>
                  <RevealButton
                    revealed={revealed}
                    label="kept copy"
                    onToggle={() => setRevealed((value) => !value)}
                  />
                  <CopyButton
                    value={kept.text}
                    label="kept copy"
                    fieldKey="kept-copy"
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                </>
              }
            >
              <ConcealedValue
                value={kept.text}
                label="kept copy"
                revealed={revealed}
              />
            </FieldRow>
          ) : (
            <FieldRow
              label="File"
              actions={
                <IconKey
                  label="Download"
                  small
                  onClick={() => downloadKeptFile(kept)}
                >
                  <IconDownload size={16} />
                </IconKey>
              }
            >
              <span className="frow__value">{kept.name}</span>
            </FieldRow>
          )}
        </section>
      ) : null}
    </>
  );
}
