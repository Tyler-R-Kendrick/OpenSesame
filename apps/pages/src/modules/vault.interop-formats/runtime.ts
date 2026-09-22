/**
 * `vault.interop-formats` — reading other managers' exports (KDBX, CXF,
 * CSV, ZIP, browser and manager formats) and writing CXF: the import
 * pipeline (`lib/vault/import/`), the CXF writer (`lib/vault/export/`) and
 * the Formats panel that drives both.
 *
 * The panel is a row under Settings › Security, where `SettingsSection.tsx`
 * draws it today, so it arrives as a settings *panel* rather than a new
 * category: adding a tab would move a control people already know. Without
 * the optional port (`ports-b.ts`) the panel is simply not offered, and the
 * import pipeline stays reachable only from code this capability owns.
 *
 * `kdbxweb` and `hash-wasm` are exclusive to this capability, and even
 * inside it they are `import()`ed from `parse()`
 * (`lib/vault/import/formats/kdbx.ts:122`) rather than at module scope —
 * Argon2 in Wasm is large, and a person who never opens a KDBX file never
 * fetches it. Activating this capability therefore loads no Wasm either.
 *
 * Egress: none. Every byte read or written is a file the person chose
 * through an `<input type="file">` or a download this page produced; no
 * format handler fetches anything.
 *
 * Side effects: none at import — the panel reads on mount, and the pipeline
 * registers no handler until it is called.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { FormatsInteroperabilityPanel } from "../../sections/settings/FormatsInteroperabilityPanel.js";
import { createActivation } from "../activation.js";
import type { ContextWithPorts } from "../ports-b.js";

export const CAPABILITY = "vault.interop-formats";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(context) {
    const ctx = context as ContextWithPorts;
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("settings-panel", {
      id: "formats-interoperability",
      category: "security",
      Panel: FormatsInteroperabilityPanel,
      order: 40,
    });

    return activation.handle();
  },
};
