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
import { IconKey } from "../../components/IconKey.js";
import { IconUpload } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { CeremonyRow } from "./CeremonyRow.js";
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
      className="panel set__security"
      id="sealed-store"
      aria-labelledby="sealed-store-title"
    >
      <div className="panel__head">
        <div>
          <h2 id="sealed-store-title">Sealed store</h2>
        </div>
      </div>
      <div className="panel__body">
        <CeremonyRow
          icon={<IconUpload size={16} />}
          label="Store path manifest"
          mark={saved ? { tone: "ok", label: `Saved ${saved}` } : null}
          sub={`${count} ${count === 1 ? "entry" : "entries"}`}
          action={
            <IconKey
              small
              keyRef={guideRef}
              label={LABEL}
              aria-haspopup="dialog"
              aria-expanded={open}
              disabled={count === 0}
              onClick={() => setOpen(true)}
            >
              <IconUpload size={16} />
            </IconKey>
          }
        />
      </div>
      {open ? <StoreManifestSheet onClose={close} onSaved={setSaved} /> : null}
    </section>
  );
}
