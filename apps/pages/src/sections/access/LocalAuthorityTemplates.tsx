import {
  AUDIENCE_TEMPLATE_IDS,
  type AudienceTemplate,
  type AudienceTemplateId,
  listAudienceTemplates,
} from "@opensesame/os-domain/authority-templates";
import { useId, useState } from "react";

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const hours = ms / (60 * 60 * 1000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function SupportStatus({ status }: { status: string }) {
  return (
    <span className="access-policy-badge">{status.replaceAll("_", " ")}</span>
  );
}

function TemplateDetail({ template }: { template: AudienceTemplate }) {
  return (
    <div className="panel__body">
      <p className="hint">{template.summary}</p>
      <p className="hint">
        Vocabulary: {template.vocabulary.domain} ·{" "}
        {template.vocabulary.participant}
        {template.vocabulary.supervisor
          ? ` · ${template.vocabulary.supervisor}`
          : null}
      </p>
      <p className="hint">
        Defaults: {template.defaults.lifetimeKind},{" "}
        {template.defaults.inheritance}, default{" "}
        {formatDuration(template.defaults.defaultLifetimeMs)}, max{" "}
        {formatDuration(template.defaults.maxLifetimeMs)}
        {template.defaults.usageAccounting
          ? `, usage ${template.defaults.usageAccounting.replaceAll("_", " ")}`
          : null}
      </p>
      <p className="hint">
        Suggested verbs: {template.defaults.suggestedVerbs.join(", ")}
      </p>
      <h3 className="access-policy-title">Support matrix</h3>
      <ul className="access-domain-list">
        {template.supportMatrix.map((claim) => (
          <li key={claim.id} className="access-domain-row">
            <div>
              <strong>{claim.label}</strong>
              <SupportStatus status={claim.status} />
              <p className="hint">{claim.note}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="hint">Workflow: {template.workflowHints.join(" · ")}</p>
    </div>
  );
}

/**
 * Lists declarative audience templates for ephemeral domain/session context.
 * Selection is local UI state only — not a grant ledger and not remote enforcement.
 */
export function LocalAuthorityTemplates() {
  const templates = listAudienceTemplates();
  const [selectedId, setSelectedId] = useState<AudienceTemplateId>(
    templates[0]?.id ?? "family",
  );
  const labelId = useId();
  const selected =
    templates.find((template) => template.id === selectedId) ?? templates[0];

  return (
    <section
      className="panel"
      id="local-authority-templates"
      aria-labelledby={labelId}
    >
      <div className="panel__head">
        <h2 id={labelId}>Audience templates</h2>
      </div>
      <div className="panel__body">
        <p className="hint access-local-authority-intro">
          Versioned vocabulary and default limits for a temporary domain or
          session. Selecting a template does not issue a grant, open a second
          lease store, or claim remote DNS/OS enforcement.
        </p>
        <label className="field">
          <span className="field__label">Template</span>
          <select
            className="input"
            value={selected?.id ?? ""}
            onChange={(event) => {
              const next = event.target.value;
              for (const id of AUDIENCE_TEMPLATE_IDS) {
                if (id === next) {
                  setSelectedId(id);
                  return;
                }
              }
            }}
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label} (v{template.version})
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <>
            <TemplateDetail template={selected} />
            <div className="found__do">
              <button
                type="button"
                className="btn btn--primary"
                aria-live="polite"
                onClick={() => setSelectedId(selected.id)}
              >
                Use {selected.label} defaults
              </button>
            </div>
            <output className="hint">
              Selected: {selected.id} — defaults only; enforcement follows wired
              adapters, not this label.
            </output>
          </>
        ) : null}
      </div>
    </section>
  );
}
