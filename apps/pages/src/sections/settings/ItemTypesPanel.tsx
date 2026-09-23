import { itemTypeRegistry } from "@opensesame/app-core/lib/vault/item-types.js";
/**
 * Item types — install and remove a VaultItemType manifest as data writes to
 * the sealed body (ADR 0087 §7; capability `vault.item_types.install`). The
 * draft is inspected through `ItemTypeVisual`, the same Source/Visual pair the
 * rest of Settings uses.
 */
import { type ComponentType, useState } from "react";
import { IconPlus, IconTrash } from "../../components/Icons.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { ItemTypeVisual } from "./ItemTypeVisual.js";

/** The vaults category: the vault switcher and the item types it can shape. */
export function VaultsAndTypes({
  VaultsPanel,
}: { VaultsPanel: ComponentType }) {
  return (
    <>
      <VaultsPanel />
      <ItemTypesPanel />
    </>
  );
}

export function ItemTypesPanel() {
  const store = useVaultStore();
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const installed = itemTypeRegistry().list();

  const install = () => {
    void (async () => {
      try {
        const result = await store.installItemTypeDefinition(draft);
        setMessage(
          result.ok
            ? "Installed. Available now — no reload needed."
            : result.message,
        );
        if (result.ok) setDraft("");
      } catch (caught) {
        setMessage(
          caught instanceof Error ? caught.message : "Install failed.",
        );
      }
    })();
  };

  const remove = (id: string) => {
    void (async () => {
      if (confirming !== id) {
        setConfirming(id);
        return;
      }
      setConfirming(null);
      await store.uninstallItemTypeDefinition(id);
      // Uninstalling a definition never rewrites the items already shaped by
      // it: their values are kept exactly as they are.
      setMessage("Removed. Item values are kept.");
    })();
  };

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Item types</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          disabled={draft.trim().length === 0}
          aria-label="Install type"
          title="Install type"
          onClick={install}
        >
          <IconPlus size={16} />
        </button>
      </div>
      <div className="panel__body">
        <ItemTypeVisual draft={draft} onDraft={setDraft} />
        <output aria-live="polite">{message}</output>
        <ul className="itype-list" aria-label="Installed types">
          {installed.map(({ definition }) => {
            const id = definition.metadata.id;
            const title = definition.spec.title ?? id;
            const verb =
              confirming === id ? "Confirm removal" : `Remove ${title}`;
            return (
              <li key={id}>
                <span>{title}</span>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  aria-label={verb}
                  title={verb}
                  onClick={() => void remove(id)}
                >
                  <IconTrash size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
