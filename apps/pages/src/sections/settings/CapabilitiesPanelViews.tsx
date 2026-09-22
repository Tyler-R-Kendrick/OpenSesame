/**
 * The three views of a capability document and the toggle between them.
 *
 * Visual is drawn by the panel that owns it; Source is the authored YAML
 * committed through the S04 adapter (a stale base revision is a conflict, a
 * comments-only edit touches nothing semantic); Effective is read-only. The
 * toggle wears `SettingsViewToggle`'s classes so it reads as the same
 * control, with the three words a document has views of.
 */

import { useEffect, useState } from "react";
import { IconCheck } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  commitInstallationSelectionSource,
  commitInstancePolicySource,
  commitVaultRestrictionSource,
  readCapabilitySource,
} from "../../lib/configuration/capabilities-adapter.js";
import {
  type CapabilityConfigPorts,
  type CapabilityResourceKind,
  capabilityResource,
  defaultCapabilityPorts,
} from "../../lib/configuration/capabilities-resources.js";
import type { CommitResult } from "../../lib/configuration/types.js";

export type CapabilityView = "visual" | "source" | "effective";

const VIEWS: ReadonlyArray<{ id: CapabilityView; label: string }> = [
  { id: "visual", label: "Visual" },
  { id: "source", label: "Source" },
  { id: "effective", label: "Effective" },
];

export function CapabilitiesViewToggle({
  view,
  onChange,
}: {
  view: CapabilityView;
  onChange: (next: CapabilityView) => void;
}) {
  return (
    <div className="set__view" role="radiogroup" aria-label="Capability view">
      {VIEWS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="set__view-btn"
          aria-pressed={view === entry.id}
          onClick={() => onChange(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

export const capabilitySourceSeams = {
  ports: (tomb: string | null): CapabilityConfigPorts =>
    defaultCapabilityPorts(() => tomb),
};

const COMMITS: Record<
  Exclude<CapabilityResourceKind, "effective-plan">,
  (ports: CapabilityConfigPorts, input: { source: string; baseRevision: string }) => Promise<CommitResult>
> = {
  "instance-policy": commitInstancePolicySource,
  "installation-selection": commitInstallationSelectionSource,
  "vault-restriction": commitVaultRestrictionSource,
};

function toneOf(result: CommitResult): "ok" | "warn" | "err" {
  if (result.status === "applied_durable") return "ok";
  if (result.status === "applied_ephemeral" || result.status === "draft_saved") return "warn";
  return "err";
}

export function CapabilitySourceView({
  kind,
  tomb,
}: {
  kind: Exclude<CapabilityResourceKind, "effective-plan">;
  tomb: string | null;
}) {
  const ports = capabilitySourceSeams.ports(tomb);
  const descriptor = capabilityResource(kind, ports.snapshot());
  const [source, setSource] = useState("");
  const [base, setBase] = useState(descriptor.revisionToken);
  const [result, setResult] = useState<CommitResult | null>(null);
  useEffect(() => {
    setSource(readCapabilitySource(kind, ports));
    setBase(capabilityResource(kind, ports.snapshot()).revisionToken);
    setResult(null);
  }, [kind, ports]);
  async function save() {
    const outcome = await COMMITS[kind](ports, { source, baseRevision: base });
    setResult(outcome);
    if (outcome.revisionToken) setBase(outcome.revisionToken);
  }
  return (
    <div className="capspanel" data-testid={`capability-source-${kind}`}>
      <div className="capspanel__head">
        <p className="set-raw__path">{descriptor.displayPath}</p>
        {descriptor.capabilities.edit ? (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Save source"
            title="Save source"
            onClick={() => void save()}
          >
            <IconCheck size={14} />
          </button>
        ) : (
          <StatusMark tone="idle" label="read-only" />
        )}
      </div>
      <textarea
        className="capspanel__source"
        aria-label={descriptor.displayPath}
        spellCheck={false}
        readOnly={!descriptor.capabilities.edit}
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />
      {result ? (
        <p className="capspanel__notice" role={toneOf(result) === "err" ? "alert" : undefined}>
          <StatusMark tone={toneOf(result)} label={result.message} />
          <span>{result.message}</span>
        </p>
      ) : null}
    </div>
  );
}
