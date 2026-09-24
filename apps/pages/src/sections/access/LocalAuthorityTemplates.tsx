import {
  AUDIENCE_TEMPLATE_IDS,
  type AudienceTemplate,
  type AudienceTemplateId,
  listAudienceTemplates,
} from "@opensesame/os-domain/authority-templates";
import { useId, useState } from "react";
import { StatusMark } from "../../components/StatusMark.js";

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const hours = ms / (60 * 60 * 1000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A claim's support is a status: a glyph whose sentence is its name. */
function SupportStatus({ status }: { status: string }) {
  return (
    <StatusMark
      tone={status === "unsupported" ? "idle" : "warn"}
      label={status.replaceAll("_", " ")}
    />
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
        <label className="field">
          <span className="label">Template</span>
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
        {selected ? <TemplateDetail template={selected} /> : null}
      </div>
    </section>
  );
}
