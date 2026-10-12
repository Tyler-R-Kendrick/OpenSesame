import type { VaultItem } from "@opensesame/vault-core";
import { type MutableRefObject, useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEdit,
  IconRefresh,
  IconShare,
  IconStar,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ReferenceKeys } from "./ReferenceKeys.js";
import { TRASH_CONFIRM } from "./vault-menu.js";

/**
 * The Share once key. It is its own component because it is the target a
 * tutorial points at (`item.share`, declared only where sharing is on), so the
 * target is claimed only where the key is drawn; the same ref takes the focus
 * back when the ceremony closes.
 */
function ShareKey({
  open,
  onToggle,
  keyRef,
}: {
  open: boolean;
  onToggle: () => void;
  keyRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const guideRef = useGuideTarget<HTMLButtonElement>("item.share");
  const ref = useCallback(
    (element: HTMLButtonElement | null) => {
      guideRef(element);
      keyRef.current = element;
    },
    [guideRef, keyRef],
  );
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-btn${open ? " is-on" : ""}`}
      onClick={onToggle}
      aria-pressed={open}
      aria-label="Share once"
      title="Share once (s)"
    >
      <IconShare size={17} />
    </button>
  );
}

/** An item in the trash: restore it, or delete it for good, which asks twice. */
function TrashedTools({
  item,
  confirmPurge,
  onConfirmPurge,
}: {
  item: VaultItem;
  confirmPurge: boolean;
  onConfirmPurge: (armed: boolean) => void;
}) {
  const navigate = useNavigate();
  const store = useVaultStore();
  const really = "Really delete permanently? This cannot be undone";
  return (
    <div className="detail__tools">
      <IconKey label="Restore" onClick={() => void store.restoreItem(item.id)}>
        <IconRefresh size={17} />
      </IconKey>
      <button
        type="button"
        className={`icon-btn${confirmPurge ? " is-armed" : ""}`}
        onClick={() => {
          if (!confirmPurge) {
            onConfirmPurge(true);
            return;
          }
          void store.purgeItem(item.id);
          navigate("/vault?f=trash");
        }}
        aria-label={confirmPurge ? really : "Delete permanently"}
        title={confirmPurge ? really : "Delete permanently"}
      >
        <IconTrash size={17} />
      </button>
      {confirmPurge ? (
        <IconKey label="Keep this item" onClick={() => onConfirmPurge(false)}>
          <IconX size={17} />
        </IconKey>
      ) : null}
    </div>
  );
}

/**
 * The item's verbs: keys in one toolbar — symbols, named for the screen reader
 * and the hover. A live item offers favorite, edit, share (where something
 * can share it) and trash; one in the trash offers restore and a delete that
 * asks twice.
 */
export function ItemTools({
  item,
  listPath,
  confirmPurge,
  onConfirmPurge,
  share,
}: {
  item: VaultItem;
  /** Where the list is, for the way out of an item that was just trashed. */
  listPath: string;
  confirmPurge: boolean;
  onConfirmPurge: (armed: boolean) => void;
  /** Present when the item can be shared once: the key's state and its press. */
  share?: {
    open: boolean;
    onToggle: () => void;
    keyRef: MutableRefObject<HTMLButtonElement | null>;
  };
}) {
  const navigate = useNavigate();
  const store = useVaultStore();
  const favoriteRef = useGuideTarget<HTMLButtonElement>("item.favorite");
  const editRef = useGuideTarget<HTMLAnchorElement>("item.edit");
  const trashRef = useGuideTarget<HTMLButtonElement>("item.trash");
  const [armedTrashId, setArmedTrashId] = useState<string | null>(null);
  const confirmTrash = armedTrashId === item.id;
  if (item.deletedAt !== null)
    return (
      <TrashedTools
        item={item}
        confirmPurge={confirmPurge}
        onConfirmPurge={onConfirmPurge}
      />
    );
  const favorite = item.favorite ? "Remove from favorites" : "Add to favorites";
  return (
    <div className="detail__tools">
      <button
        ref={favoriteRef}
        type="button"
        className={`icon-btn${item.favorite ? " is-on" : ""}`}
        onClick={() => void store.toggleFavorite(item.id)}
        aria-pressed={item.favorite}
        aria-label={favorite}
        title={favorite}
      >
        <IconStar size={17} filled={item.favorite} />
      </button>
      {item.kind !== "drop" ? (
        <Link
          ref={editRef}
          className="icon-btn"
          aria-label="Edit"
          title="Edit (e)"
          to={`/vault/${item.id}/edit`}
        >
          <IconEdit size={17} />
        </Link>
      ) : null}
      <ReferenceKeys key={item.id} item={item} />
      {share ? <ShareKey {...share} /> : null}
      <button
        ref={trashRef}
        type="button"
        className={`icon-btn${confirmTrash ? " is-armed" : ""}`}
        onClick={() => {
          if (!confirmTrash) {
            setArmedTrashId(item.id);
            return;
          }
          setArmedTrashId(null);
          void store.trashItem(item.id);
          navigate(listPath);
        }}
        aria-label={confirmTrash ? TRASH_CONFIRM : "Move to trash"}
        title={confirmTrash ? TRASH_CONFIRM : "Move to trash (x)"}
      >
        <IconTrash size={17} />
      </button>
      {confirmTrash ? (
        <IconKey label="Keep this item" onClick={() => setArmedTrashId(null)}>
          <IconX size={17} />
        </IconKey>
      ) : null}
      {confirmTrash ? (
        <p className="visually-hidden" role="alert">
          Moving to trash. Press the trash key again to confirm.
        </p>
      ) : null}
    </div>
  );
}
