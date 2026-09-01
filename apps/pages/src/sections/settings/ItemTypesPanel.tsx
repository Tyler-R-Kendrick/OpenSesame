import { useMemo, useState } from "react";
import { IconCheck, IconTrash } from "../../components/Icons.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { itemTypeRegistry } from "../../lib/vault/item-types.js";
import { itemTypeId } from "../../lib/vault/item-types.js";

type Flash = { tone: "ok" | "err"; text: string };

/**
 * Item types (ADR 0087).
 *
 * A type is inert data: a manifest naming field types from a closed
 * catalogue, how the type projects onto the base native secret, and which of
 * its fields are safe to show without a reveal gesture. Pasting one here
 * installs it — no build, no reload — and it syncs to this vault's other
 * devices inside the sealed body.
 *
 * Removing a type never touches items. An item whose type is not installed
 * keeps every value it holds and renders concealed until the definition comes
 * back; coercing it into a note would destroy it on every other device.
 */
export function ItemTypesPanel() {
  const store = useVaultStore();
  const { items } = useVault();
  const [draft, setDraft] = useState("");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const registered = itemTypeRegistry().list();
  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const id = itemTypeId(item);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  async function onInstall() {
    const text = draft.trim();
    if (text === "") {
      setFlash({ tone: "err", text: "Paste a definition first." });
      return;
    }
    setBusy(true);
    try {
      const result = await store.installItemTypeDefinition(text);
      if (!result.ok) {
        setFlash({ tone: "err", text: result.message });
        return;
      }
      setDraft("");
      setFlash({
        tone: "ok",
        text: `${result.definition.spec.title} is available now — no reload needed.`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(id: string) {
    setBusy(true);
    try {
      await store.uninstallItemTypeDefinition(id);
      setConfirmRemove(null);
      setFlash({
        tone: "ok",
        text: `${id} removed. Items of that type keep everything they hold.`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Item types</h2>
          <p>
            Every type in this vault — logins and cards included — is a
            definition, not a code path. Paste one to add a type this build has
            never heard of; it works here immediately and syncs to your other
            devices inside the sealed vault.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {flash ? (
          <p
            className={`note note--${flash.tone}`}
            role={flash.tone === "err" ? "alert" : "status"}
          >
            <span>{flash.text}</span>
          </p>
        ) : null}

        <ul className="itype-list">
          {registered.map(({ definition, source }) => {
            const id = definition.metadata.id;
            const count = usage.get(id) ?? 0;
            return (
              <li className="itype-row" key={id}>
                <div>
                  <strong>
                    {definition.spec.title}{" "}
                    <code>{definition.spec.extension}</code>
                  </strong>
                  <p className="hint">
                    {definition.spec.summary} ·{" "}
                    {source === "builtin"
                      ? "built in"
                      : `installed from ${definition.metadata.publisher}`}
                    {count > 0
                      ? ` · ${count} ${count === 1 ? "item" : "items"}`
                      : ""}
                  </p>
                </div>
                {source === "builtin" ? null : (
                  <div className="actions">
                    {confirmRemove === id ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={busy}
                        onClick={() => void onRemove(id)}
                      >
                        <IconCheck size={15} />
                        Really remove
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn icon-btn--danger"
                        aria-label={`Remove ${definition.spec.title}`}
                        title={`Remove ${definition.spec.title}`}
                        disabled={busy}
                        onClick={() => setConfirmRemove(id)}
                      >
                        <IconTrash size={16} />
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="field">
          <label htmlFor="item-type-definition">Add a type</label>
          <textarea
            id="item-type-definition"
            rows={8}
            spellCheck={false}
            placeholder='{"apiVersion":"opensesame.dev/v1alpha1","kind":"VaultItemType",…}'
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="hint">
            A definition carries no values and no code — it names field types
            from a fixed catalogue and says how the type maps onto a{" "}
            <code>pass</code> entry. Anything else is refused, with the reason.
          </p>
        </div>

        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void onInstall()}
          >
            <IconCheck size={16} />
            Install type
          </button>
        </div>
      </div>
    </section>
  );
}
