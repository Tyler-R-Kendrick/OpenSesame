import { itemTypeId, typeLabel } from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconChevronLeft } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { UpLink } from "../../components/UpLink.js";
import { useVaultList } from "../../lib/vault-list-path.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { ItemFields } from "./ItemFields.js";
import { ItemGone } from "./ItemGone.js";
import { useItemShare } from "./ItemShare.js";
import { ItemTools } from "./ItemTools.js";
import { updateItemSecret } from "./item-secret-update.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ItemDetail() {
  const { itemId } = useParams();
  const location = useLocation();
  const { listPath, backLabel } = useVaultList(location.search);
  const { items, folders } = useVault();
  const store = useVaultStore();
  const { copied, failed, copy } = useCopyFeedback();
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [confirmPurge, setConfirmPurge] = useState(false);

  const item = items.find((candidate) => candidate.id === itemId);
  const { tool: share, ceremony } = useItemShare(item, location.search);

  // biome-ignore lint/correctness/useExhaustiveDependencies: itemId is the trigger, not an input — a revealed secret must not survive a move to another item
  useEffect(() => {
    setRevealed(new Set());
    setConfirmPurge(false);
  }, [itemId]);

  if (!item) return <ItemGone listPath={listPath} />;

  const toggle = (key: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const folder = folders.find((candidate) => candidate.id === item.folderId);
  const inTrash = item.deletedAt !== null;

  return (
    <div className="detail">
      <div className="detail__head">
        <UpLink
          pane="list"
          data-pane-close=""
          className="icon-btn detail__backbtn"
          aria-label={backLabel}
          title={backLabel}
          to={listPath}
        >
          <IconChevronLeft size={17} />
        </UpLink>
        <div className="detail__heading">
          <h1>{item.name || "Untitled"}</h1>
          <div className="detail__meta">
            <span>{typeLabel(itemTypeId(item))}</span>
            {folder ? (
              <Link to={`/vault?folder=${encodeURIComponent(folder.id)}`}>
                {folder.name}
              </Link>
            ) : null}
            <span>Updated {formatDate(item.updatedAt)}</span>
            {inTrash ? <StatusMark tone="warn" label="In trash" /> : null}
          </div>
        </div>
        <ItemTools
          item={item}
          listPath={listPath}
          confirmPurge={confirmPurge}
          onConfirmPurge={setConfirmPurge}
          share={share}
        />
      </div>

      <ItemFields
        item={item}
        revealed={revealed}
        toggle={toggle}
        copied={copied}
        failed={failed}
        copy={copy}
        onUpdateSecret={(next) => updateItemSecret(item, next, store.saveItem)}
      />
      {ceremony}

      {item.fields.length > 0 ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Custom fields</h2>
          {item.fields.map((field) => (
            <FieldRow
              key={field.id}
              label={field.name || "Field"}
              actions={
                <>
                  {field.hidden ? (
                    <RevealButton
                      revealed={revealed.has(field.id)}
                      label={field.name}
                      onToggle={() => toggle(field.id)}
                    />
                  ) : null}
                  <CopyButton
                    value={field.value}
                    label={field.name}
                    fieldKey={field.id}
                    copied={copied}
                    failed={failed}
                    onCopy={copy}
                  />
                </>
              }
            >
              {field.hidden ? (
                <ConcealedValue
                  value={field.value}
                  label={field.name}
                  revealed={revealed.has(field.id)}
                />
              ) : (
                <span className="frow__value">{field.value}</span>
              )}
            </FieldRow>
          ))}
        </section>
      ) : null}

      {item.notes && item.kind !== "note" ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Notes</h2>
          <div className="frow">
            <p className="frow__notes">{item.notes}</p>
          </div>
        </section>
      ) : null}

      {confirmPurge ? (
        <p className="visually-hidden" role="alert">
          Purging deletes the encrypted record permanently. Press the trash key
          again to confirm — this cannot be undone.
        </p>
      ) : null}
    </div>
  );
}
