/**
 * Settings › Vaults › Sample data. Demonstration items are never seeded: a
 * person asks for them here, every one carries `sample: true` (the tree and
 * the detail pane badge it), and the same key takes every one of them out
 * again — DESIGN.md's "keep removing it to one action".
 *
 * The key lives in the panel head (DESIGN.md § Keys have a home) rather than
 * the vault's path strip, whose command group is New item, Import and Export
 * and nothing else (docs/design/controls.md §7).
 */

import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import {
  pressSampleKey,
  sampleKey,
} from "@opensesame/app-core/sections/vault/sample-model.js";
import { useState } from "react";
import { IconPlus, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

const NOTICE = "vault-sample-data";

export function SampleDataPanel() {
  const { items, folders } = useVault();
  const store = useVaultStore();
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.sample-data");
  const key = sampleKey(items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const press = () => {
    setBusy(true);
    setError(null);
    void pressSampleKey(key, folders, store)
      .then(() => dismissNotice(NOTICE))
      .catch((caught) => {
        const message =
          caught instanceof Error && caught.message !== ""
            ? caught.message
            : "Sample data could not be written.";
        setError(message);
        setStatusNotice({
          id: NOTICE,
          tone: "err",
          title: "Sample data",
          body: message,
        });
      })
      .finally(() => setBusy(false));
  };

  return (
    <section
      className="panel"
      id="sample-data"
      aria-labelledby="sample-data-title"
    >
      <div className="panel__head">
        <div>
          <h2 id="sample-data-title">Sample data</h2>
        </div>
        <div className="actions">
          {key.count > 0 ? (
            <StatusMark
              tone="idle"
              label={`${key.count} synthetic ${key.count === 1 ? "item" : "items"}`}
            />
          ) : null}
          {error ? <StatusMark tone="err" label={error} /> : null}
          <button
            ref={guideRef}
            type="button"
            className="icon-btn"
            aria-label={key.label}
            title={key.label}
            disabled={busy}
            aria-busy={busy}
            onClick={press}
          >
            {key.action === "remove" ? (
              <IconTrash size={16} />
            ) : (
              <IconPlus size={16} />
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
