import type { VaultItem } from "@opensesame/vault-core";
import { Link, useNavigate } from "react-router";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEdit,
  IconRefresh,
  IconStar,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

/**
 * The item's verbs: keys in one toolbar — symbols, named for the screen reader
 * and the hover. A live item offers favorite, edit and trash; one in the trash
 * offers restore and a delete that asks twice.
 */
export function ItemTools({
  item,
  listPath,
  confirmPurge,
  onConfirmPurge,
}: {
  item: VaultItem;
  /** Where the list is, for the way out of an item that was just trashed. */
  listPath: string;
  confirmPurge: boolean;
  onConfirmPurge: (armed: boolean) => void;
}) {
  const navigate = useNavigate();
  const store = useVaultStore();
  const favoriteRef = useGuideTarget<HTMLButtonElement>("item.favorite");
  const editRef = useGuideTarget<HTMLAnchorElement>("item.edit");
  const trashRef = useGuideTarget<HTMLButtonElement>("item.trash");
  if (item.deletedAt !== null) {
    const really = "Really delete permanently? This cannot be undone";
    return (
      <div className="detail__tools">
        <IconKey
          label="Restore"
          onClick={() => void store.restoreItem(item.id)}
        >
          <IconRefresh size={17} />
        </IconKey>
        <button
          type="button"
          className={`icon-btn icon-btn--danger${confirmPurge ? " is-armed" : ""}`}
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
      <button
        ref={trashRef}
        type="button"
        className="icon-btn icon-btn--danger"
        onClick={() => {
          void store.trashItem(item.id);
          navigate(listPath);
        }}
        aria-label="Move to trash"
        title="Move to trash (x)"
      >
        <IconTrash size={17} />
      </button>
    </div>
  );
}
