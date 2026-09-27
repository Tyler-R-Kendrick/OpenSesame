/**
 * `vault.interop-formats` — reading other managers' exports (KDBX, CXF,
 * CSV, ZIP, `.1pux`, browser and manager formats): the import pipeline
 * (`lib/vault/import/`), the vault's Import key and the sheet it opens, and
 * the Formats panel under Settings › Security.
 *
 * The Import key is a `vault-command`: it sits in the vault path strip's
 * command group after New item, opens the OS file picker, and the sheet it
 * opens previews the file and merges it under one explicit action (ADR 0052
 * §6). An OpenSesame encrypted backup picked there is restored with its
 * master password. The Formats panel is a row under Settings › Security,
 * where `SettingsSection.tsx` draws it, so it arrives as a settings *panel*
 * rather than a new category: adding a tab would move a control people
 * already know. The CXF writer (`lib/vault/export/`) has no caller yet; the
 * vault's Export key writes the encrypted backup (`backup.local-encrypted`).
 *
 * The sealed-store bridge (ADR 0037 §6) is a format too: the Import sheet
 * reads a store path manifest and merges it by path, and the Sealed store
 * panel under Settings › Vaults saves one for `opensesame pass seal`. It is
 * plain text, so it is never offered from the Export key (controls.md §7).
 *
 * `kdbxweb` and `hash-wasm` are exclusive to this capability, and even
 * inside it they are `import()`ed from `parse()`
 * (`lib/vault/import/formats/kdbx.ts`) rather than at module scope —
 * Argon2 in Wasm is large, and a person who never opens a KDBX file never
 * fetches it. Activating this capability therefore loads no Wasm either.
 *
 * Egress: none. Every byte read is a file the person chose through an
 * `<input type="file">`; no format handler fetches anything.
 *
 * Side effects: none at import — the key reads nothing until a file is
 * picked, and the pipeline registers no handler until it is called.
 */

import type {
  CapabilityRuntime,
  VaultCommandContribution,
} from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { FormatsInteroperabilityPanel } from "../../sections/settings/FormatsInteroperabilityPanel.js";
import { StoreManifestPanel } from "../../sections/settings/StoreManifestPanel.js";
import { ImportKey } from "../../sections/vault/import/ImportKey.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "vault.interop-formats";

/** The path strip's Import key, after New item and before Export. */
export const IMPORT_COMMAND: VaultCommandContribution = {
  id: "import",
  order: 10,
  Command: ImportKey,
};

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("vault-command", IMPORT_COMMAND);
    activation.register("settings-panel", {
      id: "formats-interoperability",
      category: "security",
      Panel: FormatsInteroperabilityPanel,
      order: 40,
    });
    activation.register("settings-panel", {
      id: "sealed-store",
      category: "vaults",
      Panel: StoreManifestPanel,
      order: 50,
    });

    return activation.handle();
  },
};
