/**
 * Settings › Capabilities as files (ADR 0134). The category keeps the
 * capability documents beside its own `config.yaml`, all under
 * `settings/capabilities/`:
 *
 * | File | Stored as | Written by |
 * |---|---|---|
 * | `installation-selection.yaml` | the installation's selection | the switches (a reviewed plan), or the file viewer |
 * | `instance-policy.yaml` | the policy authored on this device — the operator's only | the purpose presets, or the file viewer |
 * | `effective-plan.yaml` | what the two above resolve to | nothing — read-only |
 *
 * There is no Visual / Source / Effective toggle: the switches and the file
 * viewer write through the same S04 adapter, so a stale base revision is a
 * conflict, a comments-only edit touches nothing semantic, and a policy that
 * arrived from a deployment is read-only here (editing it would be forging
 * it). A file's base revision is the one its text was last read at.
 */

import {
  commitInstallationSelectionSource,
  commitInstancePolicySource,
  readCapabilitySource,
} from "../../lib/configuration/capabilities-adapter.js";
import {
  parseInstallationSelectionSource,
  parseInstancePolicySource,
} from "../../lib/configuration/capabilities-document.js";
import {
  type CapabilityConfigPorts,
  capabilityResourceEditable,
  revisionToken,
} from "../../lib/configuration/capabilities-resources.js";
import type { CommitResult } from "../../lib/configuration/types.js";
import type {
  FileCheck,
  FileOutcome,
  VirtualFile,
  VirtualFileProvider,
} from "./virtual-files.js";

export const CAPABILITIES_DIRECTORY = "settings/capabilities";
export const SELECTION_FILE = `${CAPABILITIES_DIRECTORY}/installation-selection.yaml`;
export const POLICY_FILE = `${CAPABILITIES_DIRECTORY}/instance-policy.yaml`;
export const EFFECTIVE_FILE = `${CAPABILITIES_DIRECTORY}/effective-plan.yaml`;

type Kind = "installation-selection" | "instance-policy" | "effective-plan";

const KINDS = new Map<string, Kind>([
  [SELECTION_FILE, "installation-selection"],
  [POLICY_FILE, "instance-policy"],
  [EFFECTIVE_FILE, "effective-plan"],
]);

const READ_ONLY = "This file is read-only.";
const APPLIED = new Set<CommitResult["status"]>([
  "applied_durable",
  "applied_ephemeral",
]);

export type CapabilityFilesSession = {
  ports: () => CapabilityConfigPorts;
  /** Whether the instance policy is this person's to see (the operator). */
  operator: () => boolean;
};

function parses(kind: Kind, text: string): FileCheck {
  if (kind === "effective-plan") return { ok: false, message: READ_ONLY };
  const parsed =
    kind === "instance-policy"
      ? parseInstancePolicySource(text)
      : parseInstallationSelectionSource(text);
  return parsed.ok
    ? { ok: true }
    : { ok: false, message: parsed.diagnostics[0]?.message ?? "Refused." };
}

export function capabilityFiles(
  session: CapabilityFilesSession,
): VirtualFileProvider {
  const bases = new Map<string, string>();
  const editable = (kind: Kind) =>
    capabilityResourceEditable(kind, session.ports().snapshot());

  function list(): readonly VirtualFile[] {
    const files: VirtualFile[] = [
      {
        path: SELECTION_FILE,
        language: "yaml",
        readOnly: false,
        removable: false,
      },
    ];
    if (session.operator()) {
      const managed = !editable("instance-policy");
      files.push({
        path: POLICY_FILE,
        language: "yaml",
        readOnly: managed,
        readOnlyLabel: managed
          ? "Set by this deployment; read-only"
          : undefined,
        removable: false,
      });
    }
    files.push({
      path: EFFECTIVE_FILE,
      language: "yaml",
      readOnly: true,
      readOnlyLabel: "What the selection and policy resolve to; read-only",
      removable: false,
    });
    return files;
  }

  return {
    list,
    async read(path) {
      const kind = KINDS.get(path);
      if (kind === undefined) return "";
      const ports = session.ports();
      bases.set(path, revisionToken(ports.snapshot()));
      return readCapabilitySource(kind, ports);
    },
    check(path, text): FileCheck {
      const kind = KINDS.get(path);
      if (kind === undefined || !editable(kind)) {
        return { ok: false, message: READ_ONLY };
      }
      return parses(kind, text);
    },
    async write(path, text): Promise<FileOutcome> {
      const kind = KINDS.get(path);
      if (kind === undefined || kind === "effective-plan" || !editable(kind)) {
        return { ok: false, message: READ_ONLY };
      }
      const ports = session.ports();
      const input = {
        source: text,
        baseRevision: bases.get(path) ?? revisionToken(ports.snapshot()),
      };
      const result =
        kind === "instance-policy"
          ? await commitInstancePolicySource(ports, input)
          : await commitInstallationSelectionSource(ports, input);
      if (!APPLIED.has(result.status)) {
        return { ok: false, message: result.message };
      }
      bases.set(path, result.revisionToken ?? revisionToken(ports.snapshot()));
      return { ok: true, path };
    },
    async remove() {
      return { ok: false, message: "This file cannot be removed." };
    },
  };
}
