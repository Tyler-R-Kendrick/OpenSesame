/**
 * Settings › Capabilities as files (ADR 0134). The category keeps the
 * capability documents beside its own `config.yaml`, all under
 * `settings/capabilities/`:
 *
 * | File | Stored as | Written by |
 * |---|---|---|
 * | `installation-selection.yaml` | the installation's selection | the switches (a reviewed plan), or the file viewer |
 * | `instance-policy.yaml` | the policy authored on this device — listed to the operator only | the purpose presets, or the file viewer |
 * | `effective-plan.yaml` | what the two above resolve to | nothing — read-only |
 *
 * There is no Visual / Source / Effective toggle: the switches and the file
 * viewer write through the same S04 adapter, so a stale base revision is a
 * conflict, a comments-only edit touches nothing semantic, and the instance
 * policy is the operator's alone: it is neither listed, read nor written for
 * anyone else, nor when a deployment owns it (editing that would be forging
 * it). A file's base revision is the one its text was last read at. The vault
 * restriction is an adapter resource too, but it is not a file here.
 */

import type { InstallationCapabilitySelection } from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import { PWA_DEFAULT_OPTIONALS } from "../../lib/capabilities/pwa-defaults.js";
import {
  commitInstallationSelectionSource,
  commitInstancePolicySource,
  readCapabilitySource,
} from "../../lib/configuration/capabilities-adapter.js";
import {
  documentToYaml,
  parseInstallationSelectionSource,
  parseInstancePolicySource,
} from "../../lib/configuration/capabilities-document.js";
import type { CompositionSnapshot } from "../../lib/configuration/capabilities-ports.js";
import {
  type CapabilityConfigPorts,
  capabilityResourceEditable,
  revisionToken,
} from "../../lib/configuration/capabilities-resources.js";
import type { CommitResult } from "../../lib/configuration/types.js";
import {
  isPresentationOnlyChange,
  patchYamlTopLevel,
} from "../../lib/configuration/yaml-patch.js";
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

/** Durable, or kept for this session only (the store could not write). */
function outcomeOf(
  result: CommitResult,
  path: string,
  text: string,
): FileOutcome {
  if (result.status !== "applied_ephemeral") {
    return { ok: true, path, message: result.message, tone: "ok", text };
  }
  return {
    ok: true,
    path,
    message: `${result.message} Kept for this session only.`,
    tone: "warn",
    text,
  };
}

/**
 * The starter's revision is fixed, and once it is committed every read
 * returns the committed one; the store reads a draft that reuses the
 * committed revision as a conflict. So a semantic edit that kept the
 * revision it was read at is given its own, as a switch's draft would
 * (`baseFromSnapshot`) — a comments-only edit keeps its bytes and its
 * revision, because it commits nothing.
 */
function withFreshRevision(ports: CapabilityConfigPorts, text: string): string {
  const committed = ports.snapshot().selection;
  const parsed = parseInstallationSelectionSource(text);
  if (
    !committed ||
    !parsed.ok ||
    parsed.value.revision !== committed.revision
  ) {
    return text;
  }
  const semantic = documentToYaml(overlapCast(committed));
  if (isPresentationOnlyChange(semantic, text)) return text;
  const revision = `draft-${ports.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    return patchYamlTopLevel(text, "revision", revision);
  } catch {
    return documentToYaml(overlapCast({ ...parsed.value, revision }));
  }
}

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

/**
 * The revision of a starter selection. Fixed, so the text is the same on every
 * read; the store only refuses a draft whose revision equals the committed
 * one, and there is none yet.
 */
export const STARTER_REVISION = "draft-initial";

/**
 * What an installation that never committed a selection is shown instead of an
 * empty file: a valid, empty selection bound to this installation's identity
 * (the base a switch draft starts from), ready to be edited and saved.
 */
export function starterSelection(
  snapshot: CompositionSnapshot,
): InstallationCapabilitySelection {
  return {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId:
      snapshot.plan?.identity.instanceId ??
      snapshot.policy?.instanceId ??
      "personal-local",
    installationId: snapshot.plan?.identity.installationId ?? "",
    basePolicyRevision:
      snapshot.plan?.identity.policyRevision ??
      snapshot.policy?.revision ??
      "0",
    revision: STARTER_REVISION,
    acceptedRequired: [],
    selectedOptional: [...PWA_DEFAULT_OPTIONALS],
    chosenAlternatives: {},
    delivery: { prefetch: "none", offlineCache: "shell-only" },
  };
}

export function capabilityFiles(
  session: CapabilityFilesSession,
): VirtualFileProvider {
  const bases = new Map<string, string>();
  /** The instance policy is the operator's alone, whoever asks for it. */
  const visible = (kind: Kind) =>
    kind !== "instance-policy" || session.operator();
  const editable = (kind: Kind) =>
    visible(kind) &&
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
      files.push({
        path: POLICY_FILE,
        language: "yaml",
        readOnly: false,
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
      if (kind === undefined || !visible(kind)) return "";
      const ports = session.ports();
      bases.set(path, revisionToken(ports.snapshot()));
      const source = readCapabilitySource(kind, ports);
      if (kind === "installation-selection" && source === "") {
        return documentToYaml(overlapCast(starterSelection(ports.snapshot())));
      }
      return source;
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
      const source =
        kind === "installation-selection"
          ? withFreshRevision(ports, text)
          : text;
      const input = {
        source,
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
      return outcomeOf(result, path, source);
    },
    async remove() {
      return { ok: false, message: "This file cannot be removed." };
    },
  };
}
