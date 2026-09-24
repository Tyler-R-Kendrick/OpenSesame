import { TRANSPORT_POLICIES } from "@opensesame/app-core/lib/transport-model.js";
import { policyLabel } from "@opensesame/app-core/lib/transport-rows.js";
import {
  EXECUTION_TARGETS,
  type LocatorKind,
  type TransportExecutionTarget,
  type TransportTargetSettings,
  isRefName,
  locatorKind,
} from "@opensesame/app-core/lib/transport-settings.js";
import { useEffect, useState } from "react";
import { StatusMark } from "../../../components/StatusMark.js";

const EXECUTION_LABEL: Record<TransportExecutionTarget, string> = {
  browser: "This browser",
  host: "Authority service",
  worker: "Worker",
};

const REFUSAL: Record<LocatorKind, string> = {
  path: "A path is not a reference",
  socket: "A socket is not a reference",
  url: "An address is not a reference",
  pem: "A certificate is not a reference",
  key: "A key is not a reference",
};

/** Why a typed value is not a reference name, as the glyph's sentence. */
export function refRefusal(value: string): string | null {
  if (value === "") return null;
  const kind = locatorKind(value);
  if (kind) return REFUSAL[kind];
  return isRefName(value) ? null : "Not a reference name";
}

/** A reference field: a name is written, a locator is refused with its reason. */
function RefField({
  id,
  label,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  /** Said inside an empty field, which otherwise drew as a bare underline. */
  placeholder: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const refusal = refRefusal(draft.trim());
  const commit = () => {
    const next = draft.trim();
    if (refRefusal(next) === null && next !== value) onCommit(next);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="transport__ref">
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
        {refusal ? <StatusMark tone="err" label={refusal} /> : null}
      </div>
    </div>
  );
}

/** A choice among named options — text on a control is only ever a choice. */
function ChoiceField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Pick a configured target, or name a new one (a name, never an address). */
function TargetField({
  target,
  targets,
  onTarget,
}: {
  target: string;
  targets: readonly string[];
  onTarget: (next: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const known = targets.includes(target) ? targets : [target, ...targets];
  return (
    <>
      <ChoiceField
        id="transport-target"
        label="Target"
        value={naming ? "__new" : target}
        options={[
          ...known.map((name) => ({ value: name, label: name })),
          { value: "__new", label: "New target…" },
        ]}
        onChange={(next) => {
          if (next === "__new") setNaming(true);
          else {
            setNaming(false);
            onTarget(next);
          }
        }}
      />
      {naming ? (
        <RefField
          id="transport-target-name"
          label="Target name"
          placeholder="e.g. office-gateway"
          value=""
          onCommit={(name) => {
            if (!name) return;
            setNaming(false);
            onTarget(name);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The desired transport for one target, spelled in references. What a person
 * wants; never what enforces it (UI-CONFIG). Every value is a name or a
 * choice, and `transport-settings.ts` refuses anything else before it is
 * written.
 */
export function TransportTargetForm({
  target,
  targets,
  settings,
  onTarget,
  onChange,
}: {
  target: string;
  targets: readonly string[];
  settings: TransportTargetSettings;
  onTarget: (next: string) => void;
  onChange: (next: TransportTargetSettings) => void;
}) {
  const update = (patch: Partial<TransportTargetSettings>) => {
    const next: TransportTargetSettings = { ...settings, ...patch };
    for (const key of ["identityRef", "trustRef", "browserProfile"] as const) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(next);
  };
  return (
    <form
      className="transport__form"
      aria-label="Desired transport"
      onSubmit={(event) => event.preventDefault()}
    >
      <TargetField target={target} targets={targets} onTarget={onTarget} />
      <ChoiceField
        id="transport-policy"
        label="Policy"
        value={settings.desiredPolicy}
        options={TRANSPORT_POLICIES.map((p) => ({
          value: p,
          label: policyLabel(p),
        }))}
        onChange={(next) => {
          const policy = TRANSPORT_POLICIES.find((p) => p === next);
          if (policy) update({ desiredPolicy: policy });
        }}
      />
      <ChoiceField
        id="transport-execution"
        label="Runs in"
        value={settings.executionTarget}
        options={EXECUTION_TARGETS.map((t) => ({
          value: t,
          label: EXECUTION_LABEL[t],
        }))}
        onChange={(next) => {
          const where = EXECUTION_TARGETS.find((t) => t === next);
          if (where) update({ executionTarget: where });
        }}
      />
      <RefField
        id="transport-identity"
        label="Identity"
        placeholder="A certificate's name — none"
        value={settings.identityRef?.name ?? ""}
        onCommit={(name) =>
          update({ identityRef: name ? { name } : undefined })
        }
      />
      <RefField
        id="transport-trust"
        label="Trust"
        placeholder="A trust bundle's name — none"
        value={settings.trustRef?.name ?? ""}
        onCommit={(name) => update({ trustRef: name ? { name } : undefined })}
      />
      <ChoiceField
        id="transport-profile"
        label="Remote profile"
        value={settings.browserProfile ? "browser_managed" : "none"}
        options={[
          { value: "none", label: "None" },
          { value: "browser_managed", label: "Browser-managed certificate" },
        ]}
        onChange={(next) =>
          update({
            browserProfile:
              next === "browser_managed"
                ? {
                    kind: "browser_managed",
                    displayName: "Browser certificate",
                  }
                : undefined,
          })
        }
      />
    </form>
  );
}
