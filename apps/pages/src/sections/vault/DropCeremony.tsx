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
 * card carries only the link, the user code, the QR, and the expiry.
 */

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
import { DROP_TTL_OPTIONS } from "./DropTtl.js";
import { ShareForm, ShareOffer, useShareFocus } from "./ShareOffer.js";
import { formatExpiry } from "./expiry.js";

/** What a finished ceremony shows: link, code, QR, expiry — never the payload. */
export function DropCard({ drop }: { drop: SharedOnce }) {
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
      <div className="drop-card__qr">
        <QrCode
          value={drop.link}
          label="Scan to open this drop"
          shortcode={drop.userCode}
          size={144}
        />
      </div>
      <p className="hint">Expires {formatExpiry(drop.expiresAt)}.</p>
    </section>
  );
}

/** Share ceremony on a stored item. The item is untouched. */
export function ShareSecretDrop({
  item,
  initialOpen = false,
}: {
  item: VaultItem;
  initialOpen?: boolean;
}) {
  const text = shareText(item);
  const [open, setOpen] = useState(initialOpen);
  const [ttlMs, setTtlMs] = useState<number>(DROP_TTL_OPTIONS[1].ms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drop, setDrop] = useState<SharedOnce | null>(null);
  const focus = useShareFocus(open);

  async function share() {
    if (text === null) return;
    setBusy(true);
    setError(null);
    try {
      const name = item.name || "Shared item";
      setDrop(await shareOnce({ name, text, ttlMs }));
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

  if (text === null) return null;

  if (drop) {
    return (
      <section className="detail__group">
        <DropCard drop={drop} />
      </section>
    );
  }

  if (!open) {
    return (
      <ShareOffer
        keyRef={focus.keyRef}
        onOpen={() => {
          focus.expect("ttl");
          setOpen(true);
        }}
      />
    );
  }

  return (
    <ShareForm
      ttlMs={ttlMs}
      onTtl={setTtlMs}
      ttlRef={focus.ttlRef}
      notice={
        error ? (
          <p className="note note--err" role="alert">
            <span>{error}</span>
          </p>
        ) : null
      }
      busy={busy}
      onSeal={() => void share()}
      onCancel={() => {
        focus.expect("key");
        setOpen(false);
      }}
    />
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
  const [now, setNow] = useState(() => Date.now());
  const [revealed, setRevealed] = useState(false);
  const { copied, failed, copy } = useCopyFeedback();
  const kept = item.keptCopy;

  // Disposal: poll once per viewing; a terminal claim purges the record, and
  // so does the TTL lapsing while this page is open.
  useEffect(() => {
    void sweepDrop(item, () => store.purgeItem(item.id));
  }, [item, store]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

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
        <p className="hint">
          This record is purged as soon as the drop is opened or lapses.
        </p>
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
