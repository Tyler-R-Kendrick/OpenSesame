import { sopsCapability } from "../../lib/sops/capability.js";
/**
 * View-model logic for `FormatsInteroperabilityPanel` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  ageCapability,
  gpgCapability,
  nativeManifestCapability,
} from "../../lib/vault/protection/sops-browser.js";

export type Capability = "ok" | "warn" | "idle";

export type FormatRow = {
  id: string;
  name: string;
  read: { tone: Capability; label: string };
  write: { tone: Capability; label: string };
  runtime: { tone: Capability; label: string };
};

export function buildFormats(): readonly FormatRow[] {
  const age = ageCapability();
  const sops = sopsCapability();
  const gpg = gpgCapability();
  const native = nativeManifestCapability();
  return [
    {
      id: "native",
      name: "Native",
      read: { tone: "ok", label: "Read" },
      write: { tone: "ok", label: "Write" },
      runtime: {
        tone: native.runtime === "browser" ? "ok" : "warn",
        label: "This browser",
      },
    },
    {
      id: "age",
      name: "age",
      read: { tone: "ok", label: "Read" },
      write: { tone: "ok", label: "Write" },
      runtime: {
        tone: age.runtime === "browser" ? "ok" : "warn",
        label: "This browser",
      },
    },
    {
      id: "sops",
      name: "SOPS",
      read: { tone: sops.available ? "ok" : "idle", label: "Read" },
      write: { tone: sops.available ? "ok" : "idle", label: "Write" },
      runtime: {
        tone: sops.runtime === "browser" ? "ok" : "idle",
        label: "This browser",
      },
    },
    {
      id: "gpg",
      name: "GPG",
      read: { tone: "ok", label: "Read" },
      write: { tone: "idle", label: "Write not in this browser" },
      runtime: {
        tone: "idle",
        label: gpg.available ? "This browser" : "Native or external tooling",
      },
    },
  ];
}
