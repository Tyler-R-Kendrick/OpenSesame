/**
 * Settings › Vaults › Sealed store (`vault.interop-formats`, ADR 0037 §6):
 * the store path manifest `opensesame pass seal <file> --shred` turns into
 * a git-native sealed store. The file is plain text, so it is never offered
 * from the vault's Export key — that key writes ciphertext only
 * (docs/design/controls.md §7). A manifest comes back through the vault's
 * Import key, which reads it and merges it by store path.
 */

import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { storeManifestFile } from "@opensesame/app-core/sections/vault/import/store-manifest.js";
import { useState } from "react";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { IconUpload } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { downloadSeams } from "../../screens/capabilities/download.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

const NOTICE = "vault-store-manifest";
const LABEL = "Save store path manifest";

export function StoreManifestPanel() {
  const { items, folders } = useVault();
  const guideRef = useGuideTarget<HTMLButtonElement>("vault.store-manifest");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = storeManifestFile(items, folders).count;

  const save = () => {
    try {
      const file = storeManifestFile(items, folders);
      downloadSeams.save(file.fileName, file.text, "application/json");
      setSaved(file.fileName);
      setError(null);
      dismissNotice(NOTICE);
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "The manifest was not saved.";
      setError(message);
      setStatusNotice({
        id: NOTICE,
        tone: "err",
        title: "Sealed store",
        body: message,
      });
    }
  };

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
          {saved && !error ? (
            <StatusMark tone="ok" label={`Saved ${saved}`} />
          ) : null}
          {error ? <StatusMark tone="err" label={error} /> : null}
          <button
            ref={guideRef}
            type="button"
            className="icon-btn"
            aria-label={LABEL}
            title={LABEL}
            disabled={count === 0}
            onClick={save}
          >
            <IconUpload size={16} />
          </button>
        </div>
      </div>
      <div className="panel__body">
        <CeremonyShell
          ok
          name="Store path manifest"
          facts={[
            { key: "Entries", value: String(count) },
            { key: "Holds", value: "plain text" },
            { key: "Seal with", value: "opensesame pass seal <file> --shred" },
            { key: "Read back", value: "the vault's Import key" },
          ]}
        />
      </div>
    </section>
  );
}
