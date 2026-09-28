/**
 * Settings › Vaults › Sealed store (`vault.interop-formats`, ADR 0037 §6):
 * the store path manifest `opensesame pass seal <file> --shred` turns into
 * a git-native sealed store. The file is plain text, so it is never offered
 * from the vault's Export key — that key writes ciphertext only
 * (docs/design/controls.md §7). A manifest comes back through the vault's
 * Import key, which reads it and merges it by store path.
 */

import { storeManifestFile } from "@opensesame/app-core/sections/vault/import/store-manifest.js";
import { useCallback, useState } from "react";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { IconUpload } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { StoreManifestSheet } from "./StoreManifestSheet.js";

const LABEL = "Save store path manifest";

export function StoreManifestPanel() {
  const { items, folders } = useVault();
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.store-manifest");
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const count = storeManifestFile(items, folders).count;

  return (
    <section
      className="panel"
      id="sealed-store"
      aria-labelledby="sealed-store-title"
    >
      <div className="panel__head">
        <div>
          <h2 id="sealed-store-title">Sealed store</h2>
        </div>
        <div className="actions">
          {saved ? <StatusMark tone="ok" label={`Saved ${saved}`} /> : null}
          <button
            ref={guideRef}
            type="button"
            className="icon-btn"
            aria-label={LABEL}
            title={LABEL}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={count === 0}
            onClick={() => setOpen(true)}
          >
            <IconUpload size={16} />
          </button>
        </div>
      </div>
      {open ? <StoreManifestSheet onClose={close} onSaved={setSaved} /> : null}
      <div className="panel__body">
        <CeremonyShell
          ok
          name="Store path manifest"
          facts={[
            { key: "Entries", value: String(count) },
            { key: "Holds", value: "every value in plain text" },
            { key: "Seal with", value: "opensesame pass seal <file> --shred" },
            { key: "Read back", value: "the vault's Import key" },
          ]}
        />
      </div>
    </section>
  );
}
